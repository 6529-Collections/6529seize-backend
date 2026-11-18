import {
  affectedRows,
  BackupSink,
  BatchOptions,
  batchSettings,
  BatchSettings,
  chunk,
  compareStrings,
  currentDatabase,
  identifier,
  inTransaction,
  pause,
  placeholders,
  retryOnLockConflict,
  scalar,
  sha256Lines,
  SqlRunner,
  withNamedLock
} from './operator-sql';

// Operator-only rollback of the REP a revoked profile proxy gave on behalf of its grantor.
// It applies the same rep, level and aggregation deltas the rating service applies when a
// rating returns to zero, but stays silent: no activity logs, notifications or events.

export interface ProxyRepRollbackCounts {
  rating_rows: number;
  nonzero_rating_rows: number;
  rep_sum: number;
  targets: number;
  activity_logs: number;
  notifications: number;
  credit_balance_rows: number;
}

export interface ProxyRepRollbackPlan {
  version: 1;
  database: string;
  proxy_id: string;
  grantor_profile_id: string;
  grantee_profile_id: string;
  rep_action_ids: string[];
  planned_at: number;
  categories: string[];
  skipped_categories: string[];
  targets_sha256: string;
  counts: ProxyRepRollbackCounts;
}

export interface ProxyRepRollbackResult {
  rating_rows: number;
  rep_removed: number;
  identities_updated: number;
  aggregation_rows_deleted: number;
  notifications: number;
  activity_logs: number;
  credit_balance_rows: number;
}

export interface RatingDelta {
  profile_id: string;
  rep: number;
  nonzero: number;
}

const LOCK_NAME = 'rollback-proxy-rep-v1';
const DEFAULT_BATCH_SIZE = 1000;
const CATEGORY_IN_LOG = `JSON_UNQUOTE(JSON_EXTRACT(contents, '$.rating_category'))`;
const MATTER_IN_LOG = `JSON_UNQUOTE(JSON_EXTRACT(contents, '$.rating_matter'))`;
const REASON_IN_LOG = `JSON_UNQUOTE(JSON_EXTRACT(contents, '$.change_reason'))`;
const CATEGORY_IN_NOTIFICATION = `JSON_UNQUOTE(JSON_EXTRACT(additional_data, '$.category'))`;

/** Per-target totals of the ratings being removed, in target order. */
export function summarizeRatingDeltas(
  rows: readonly { matter_target_id: string; rating: number | string }[]
): RatingDelta[] {
  const byTarget = new Map<string, RatingDelta>();
  for (const row of rows) {
    const rating = Number(row.rating);
    const delta = byTarget.get(row.matter_target_id) ?? {
      profile_id: row.matter_target_id,
      rep: 0,
      nonzero: 0
    };
    delta.rep += rating;
    delta.nonzero += rating === 0 ? 0 : 1;
    byTarget.set(row.matter_target_id, delta);
  }
  return Array.from(byTarget.values()).sort((a, b) =>
    compareStrings(a.profile_id, b.profile_id)
  );
}

/** `column = column - CASE profile_id WHEN ? THEN ? ... END` with its parameters. */
export function subtractCase(
  column: string,
  deltas: readonly RatingDelta[],
  pick: (delta: RatingDelta) => number
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const whens = deltas.map((delta) => {
    params.push(delta.profile_id, pick(delta));
    return 'WHEN ? THEN ?';
  });
  const target = identifier(column);
  return {
    sql: `${target} = ${target} - CASE profile_id ${whens.join(' ')} ELSE 0 END`,
    params
  };
}

async function loadProxy(runner: SqlRunner, proxyId: string) {
  const [proxy]: { created_by: string; target_id: string }[] =
    await runner.query(
      'SELECT created_by, target_id FROM profile_proxies WHERE id = ?',
      [proxyId]
    );
  if (!proxy) throw new Error(`Proxy ${proxyId} not found`);
  const actions: { id: string; revoked_at: string | number | null }[] =
    await runner.query(
      `SELECT id, revoked_at FROM profile_proxy_actions WHERE proxy_id = ? AND action_type = 'ALLOCATE_REP' ORDER BY id`,
      [proxyId]
    );
  if (!actions.length) throw new Error('Proxy has no ALLOCATE_REP action');
  const now = Date.now();
  const active = actions.filter(
    (action) => action.revoked_at === null || Number(action.revoked_at) > now
  );
  if (active.length) {
    throw new Error('Revoke every ALLOCATE_REP action before rolling it back');
  }
  return {
    grantor: proxy.created_by,
    grantee: proxy.target_id,
    actionIds: actions.map((action) => action.id)
  };
}

async function categoriesWrittenByProxy(
  runner: SqlRunner,
  grantor: string,
  grantee: string
): Promise<string[]> {
  const rows: { category: string | null }[] = await runner.query(
    `SELECT DISTINCT ${CATEGORY_IN_LOG} AS category FROM profile_activity_logs
     WHERE proxy_id = ? AND type = 'RATING_EDIT' AND profile_id = ? AND ${MATTER_IN_LOG} = 'REP'`,
    [grantee, grantor]
  );
  return rows
    .map((row) => row.category)
    .filter((category): category is string => !!category)
    .sort(compareStrings);
}

/** Categories the grantor or another proxy also edited by hand; those stay untouched. */
async function categoriesEditedByOthers(
  runner: SqlRunner,
  grantor: string,
  grantee: string,
  categories: readonly string[],
  since: number | null
): Promise<string[]> {
  const params: unknown[] = [grantor, grantee, ...categories];
  let sinceClause = '';
  if (since !== null) {
    sinceClause = 'AND created_at > ?';
    params.push(new Date(since));
  }
  const rows: { category: string }[] = await runner.query(
    `SELECT DISTINCT ${CATEGORY_IN_LOG} AS category FROM profile_activity_logs
     WHERE profile_id = ? AND type = 'RATING_EDIT' AND (proxy_id IS NULL OR proxy_id <> ?)
       AND ${MATTER_IN_LOG} = 'REP' AND ${REASON_IN_LOG} = 'USER_EDIT'
       AND ${CATEGORY_IN_LOG} IN (${placeholders(categories)}) ${sinceClause}`,
    params
  );
  return rows.map((row) => row.category).sort(compareStrings);
}

async function assertSafeToRollBack(
  runner: SqlRunner,
  grantor: string,
  categories: readonly string[]
) {
  const pendingEvents = await scalar(
    runner,
    `SELECT COUNT(*) FROM events WHERE type = 'PROFILE_REP_RATE' AND status = 'NEW'
       AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.rater_profile_id')) = ?`,
    [grantor]
  );
  if (pendingEvents > 0) {
    throw new Error(
      `${pendingEvents} REP events from the grantor are unprocessed; retry after the event loop drains them`
    );
  }
  const votingWaves: { id: string }[] = await runner.query(
    `SELECT id FROM waves WHERE voting_credit_type = 'REP'
       AND (voting_credit_category IS NULL OR voting_credit_category IN (${placeholders(categories)}))
       AND (voting_credit_creditor IS NULL OR voting_credit_creditor = ?)`,
    [...categories, grantor]
  );
  if (votingWaves.length) {
    throw new Error(
      `Waves vote with this REP (${votingWaves.map((wave) => wave.id).join(', ')}); revoke their drop votes first`
    );
  }
}

async function listTargets(
  runner: SqlRunner,
  grantor: string,
  categories: readonly string[]
): Promise<string[]> {
  const rows: { matter_target_id: string }[] = await runner.query(
    `SELECT DISTINCT matter_target_id FROM ratings
     WHERE rater_profile_id = ? AND matter = 'REP' AND matter_category IN (${placeholders(categories)})`,
    [grantor, ...categories]
  );
  return rows.map((row) => row.matter_target_id).sort(compareStrings);
}

async function countPlan(
  runner: SqlRunner,
  ids: { grantor: string; grantee: string; actionIds: readonly string[] },
  categories: readonly string[],
  targets: number
): Promise<ProxyRepRollbackCounts> {
  const [ratings]: {
    rating_rows: string;
    nonzero_rating_rows: string | null;
    rep_sum: string | null;
  }[] = await runner.query(
    `SELECT COUNT(*) AS rating_rows, SUM(rating <> 0) AS nonzero_rating_rows, SUM(rating) AS rep_sum
     FROM ratings WHERE rater_profile_id = ? AND matter = 'REP' AND matter_category IN (${placeholders(categories)})`,
    [ids.grantor, ...categories]
  );
  return {
    rating_rows: Number(ratings.rating_rows),
    nonzero_rating_rows: Number(ratings.nonzero_rating_rows ?? 0),
    rep_sum: Number(ratings.rep_sum ?? 0),
    targets,
    activity_logs: await scalar(
      runner,
      `SELECT COUNT(*) FROM profile_activity_logs WHERE proxy_id = ? AND type = 'RATING_EDIT' AND profile_id = ?
         AND ${CATEGORY_IN_LOG} IN (${placeholders(categories)})`,
      [ids.grantee, ids.grantor, ...categories]
    ),
    notifications: await scalar(
      runner,
      `SELECT COUNT(*) FROM identity_notifications WHERE additional_identity_id = ? AND cause = 'IDENTITY_REP'
         AND ${CATEGORY_IN_NOTIFICATION} IN (${placeholders(categories)})`,
      [ids.grantor, ...categories]
    ),
    credit_balance_rows: await scalar(
      runner,
      `SELECT COUNT(*) FROM profile_proxy_rating_credit_balances WHERE proxy_action_id IN (${placeholders(ids.actionIds)})`,
      [...ids.actionIds]
    )
  };
}

/** Read-only. Returns the plan and the sorted target profile ids it covers. */
export async function inspectProxyRepRollback(
  runner: SqlRunner,
  proxyId: string
): Promise<{ plan: ProxyRepRollbackPlan; targets: string[] }> {
  const database = await currentDatabase(runner);
  const plannedAt = Date.now();
  const proxy = await loadProxy(runner, proxyId);
  const written = await categoriesWrittenByProxy(
    runner,
    proxy.grantor,
    proxy.grantee
  );
  if (!written.length) throw new Error('Proxy wrote no REP ratings');
  const skipped = await categoriesEditedByOthers(
    runner,
    proxy.grantor,
    proxy.grantee,
    written,
    null
  );
  const categories = written.filter((category) => !skipped.includes(category));
  if (!categories.length) {
    throw new Error('Every proxy category was also edited by others');
  }
  await assertSafeToRollBack(runner, proxy.grantor, categories);
  const targets = await listTargets(runner, proxy.grantor, categories);
  const counts = await countPlan(runner, proxy, categories, targets.length);
  return {
    plan: {
      version: 1,
      database,
      proxy_id: proxyId,
      grantor_profile_id: proxy.grantor,
      grantee_profile_id: proxy.grantee,
      rep_action_ids: proxy.actionIds,
      planned_at: plannedAt,
      categories,
      skipped_categories: skipped,
      targets_sha256: sha256Lines(targets),
      counts
    },
    targets
  };
}

async function verifyPlanStillApplies(
  runner: SqlRunner,
  plan: ProxyRepRollbackPlan,
  targets: readonly string[]
) {
  if ((await currentDatabase(runner)) !== plan.database) {
    throw new Error('Plan database mismatch');
  }
  if (sha256Lines(targets) !== plan.targets_sha256) {
    throw new Error('Target list does not match the plan');
  }
  const proxy = await loadProxy(runner, plan.proxy_id);
  if (
    proxy.grantor !== plan.grantor_profile_id ||
    proxy.grantee !== plan.grantee_profile_id ||
    proxy.actionIds.join() !== plan.rep_action_ids.join()
  ) {
    throw new Error('Proxy changed since the plan');
  }
  const newEdits = await categoriesEditedByOthers(
    runner,
    plan.grantor_profile_id,
    plan.grantee_profile_id,
    plan.categories,
    plan.planned_at
  );
  if (newEdits.length) {
    throw new Error(
      `Categories were edited by others after planning: ${newEdits.join(', ')}`
    );
  }
  await assertSafeToRollBack(runner, plan.grantor_profile_id, plan.categories);
}

async function subtractDeltas(
  runner: SqlRunner,
  deltas: readonly RatingDelta[]
): Promise<{ identities: number; aggregations: number }> {
  const repChanges = deltas.filter((delta) => delta.rep !== 0);
  let identities = 0;
  if (repChanges.length) {
    const rep = subtractCase('rep', repChanges, (delta) => delta.rep);
    const level = subtractCase('level_raw', repChanges, (delta) => delta.rep);
    const ids = repChanges.map((delta) => delta.profile_id);
    identities = affectedRows(
      await runner.query(
        `UPDATE identities SET ${rep.sql}, ${level.sql} WHERE profile_id IN (${placeholders(ids)})`,
        [...rep.params, ...level.params, ...ids]
      )
    );
  }
  const scoreChanges = deltas.filter(
    (delta) => delta.rep !== 0 || delta.nonzero !== 0
  );
  let aggregations = 0;
  if (scoreChanges.length) {
    const score = subtractCase('score', scoreChanges, (delta) => delta.rep);
    const raters = subtractCase(
      'rater_count',
      scoreChanges,
      (delta) => delta.nonzero
    );
    const ids = scoreChanges.map((delta) => delta.profile_id);
    await runner.query(
      `UPDATE profile_total_rep_score_aggregations SET ${score.sql}, ${raters.sql} WHERE profile_id IN (${placeholders(ids)})`,
      [...score.params, ...raters.params, ...ids]
    );
    aggregations = affectedRows(
      await runner.query(
        `DELETE FROM profile_total_rep_score_aggregations WHERE profile_id IN (${placeholders(ids)}) AND score = 0 AND rater_count = 0`,
        ids
      )
    );
  }
  return { identities, aggregations };
}

async function rollBackTargetBatch(
  runner: SqlRunner,
  plan: ProxyRepRollbackPlan,
  targets: readonly string[],
  sink: BackupSink
) {
  return inTransaction(runner, async () => {
    const filter = `rater_profile_id = ? AND matter = 'REP' AND matter_category IN (${placeholders(plan.categories)})
      AND matter_target_id IN (${placeholders(targets)})`;
    const params = [plan.grantor_profile_id, ...plan.categories, ...targets];
    const ratings: { matter_target_id: string; rating: number }[] =
      await runner.query(
        `SELECT * FROM ratings WHERE ${filter} FOR UPDATE`,
        params
      );
    if (!ratings.length) {
      return { ratings: 0, rep: 0, identities: 0, aggregations: 0 };
    }
    const deltas = summarizeRatingDeltas(ratings);
    const ids = deltas.map((delta) => delta.profile_id);
    sink.write('ratings', ratings);
    sink.write(
      'identities',
      await runner.query(
        `SELECT * FROM identities WHERE profile_id IN (${placeholders(ids)}) FOR UPDATE`,
        ids
      )
    );
    sink.write(
      'profile_total_rep_score_aggregations',
      await runner.query(
        `SELECT * FROM profile_total_rep_score_aggregations WHERE profile_id IN (${placeholders(ids)}) FOR UPDATE`,
        ids
      )
    );
    await runner.query(`DELETE FROM ratings WHERE ${filter}`, params);
    const changed = await subtractDeltas(runner, deltas);
    return {
      ratings: ratings.length,
      rep: deltas.reduce((sum, delta) => sum + delta.rep, 0),
      ...changed
    };
  });
}

/** Deletes rows matched by `select` (which must stop matching deleted rows) until none are left. */
async function drain(
  runner: SqlRunner,
  query: { table: string; select: string; params: unknown[] },
  sink: BackupSink,
  settings: BatchSettings
): Promise<number> {
  let total = 0;
  for (;;) {
    const rows: { id: unknown }[] = await runner.query(
      `${query.select} LIMIT ${settings.batchSize}`,
      query.params
    );
    if (!rows.length) return total;
    const ids = rows.map((row) => row.id);
    sink.write(query.table, rows);
    await runner.query(
      `DELETE FROM ${identifier(query.table)} WHERE id IN (${placeholders(ids)})`,
      ids
    );
    total += rows.length;
    settings.log(`${query.table}: deleted ${total}`);
    await pause(settings.pauseMs);
  }
}

async function rollBackRatings(
  runner: SqlRunner,
  plan: ProxyRepRollbackPlan,
  targets: readonly string[],
  sink: BackupSink,
  settings: BatchSettings
) {
  const totals = { rating_rows: 0, rep: 0, identities: 0, aggregations: 0 };
  for (const batch of chunk(targets, settings.batchSize)) {
    const done = await retryOnLockConflict(() =>
      rollBackTargetBatch(runner, plan, batch, sink)
    );
    totals.rating_rows += done.ratings;
    totals.rep += done.rep;
    totals.identities += done.identities;
    totals.aggregations += done.aggregations;
    settings.log(
      `ratings: deleted ${totals.rating_rows} rows, ${totals.rep} REP`
    );
    await pause(settings.pauseMs);
  }
  return totals;
}

/** Called only by the explicit operator CLI with an approved plan. Safe to re-run after a failure. */
export async function executeProxyRepRollback(
  runner: SqlRunner,
  plan: ProxyRepRollbackPlan,
  targets: readonly string[],
  sink: BackupSink,
  options: BatchOptions = {}
): Promise<ProxyRepRollbackResult> {
  const settings = batchSettings(options, DEFAULT_BATCH_SIZE);
  return withNamedLock(runner, LOCK_NAME, async () => {
    await verifyPlanStillApplies(runner, plan, targets);
    const ratings = await rollBackRatings(
      runner,
      plan,
      targets,
      sink,
      settings
    );
    const notifications = await drain(
      runner,
      {
        table: 'identity_notifications',
        select: `SELECT * FROM identity_notifications WHERE additional_identity_id = ? AND cause = 'IDENTITY_REP'
          AND ${CATEGORY_IN_NOTIFICATION} IN (${placeholders(plan.categories)}) ORDER BY id`,
        params: [plan.grantor_profile_id, ...plan.categories]
      },
      sink,
      settings
    );
    const activityLogs = await drain(
      runner,
      {
        table: 'profile_activity_logs',
        select: `SELECT * FROM profile_activity_logs WHERE proxy_id = ? AND type = 'RATING_EDIT' AND profile_id = ?
          AND ${CATEGORY_IN_LOG} IN (${placeholders(plan.categories)})`,
        params: [
          plan.grantee_profile_id,
          plan.grantor_profile_id,
          ...plan.categories
        ]
      },
      sink,
      settings
    );
    const creditBalances = await drain(
      runner,
      {
        table: 'profile_proxy_rating_credit_balances',
        select: `SELECT * FROM profile_proxy_rating_credit_balances WHERE proxy_action_id IN (${placeholders(plan.rep_action_ids)})`,
        params: [...plan.rep_action_ids]
      },
      sink,
      settings
    );
    return {
      rating_rows: ratings.rating_rows,
      rep_removed: ratings.rep,
      identities_updated: ratings.identities,
      aggregation_rows_deleted: ratings.aggregations,
      notifications,
      activity_logs: activityLogs,
      credit_balance_rows: creditBalances
    };
  });
}
