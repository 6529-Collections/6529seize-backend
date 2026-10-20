import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_MIGRATIONS_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  COMPETITION_OUTBOX_TABLE
} from '@/constants';
import { SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { NATIVE_SCORE_SEQUENCE_BASE } from './competition-score-history';
import { CompetitionRepository } from './competition.repository';
import { NativeCompetitionReader } from './native-competition.reader';
import { stableUuid } from './competition-id';
import { Competition } from './competition.types';
import { computeCompetitionPhase } from './competition-phase';

export type CompetitionHistoryParity = {
  readonly competition_id: string;
  readonly aggregate_rows: number;
  readonly voter_rows: number;
  readonly activity_rows: number;
};

type HistoryKind = 'AGGREGATE' | 'VOTER';
type TransferOwner = {
  id: string;
  wave_id: string;
  legacy_wave_id: string | null;
};
export type CompetitionHistoryTransferOptions = {
  readonly batchSize?: number;
  readonly onBatch?: (progress: {
    competition_id: string;
    stream: HistoryKind | 'NATIVE' | 'ACTIVITY' | 'VOTE_CONTEXT';
    rows: number;
    after: string | number;
  }) => Promise<void>;
};

/** Deployment-only, restartable keyset transfer. Each score batch owns and
 * releases its competition lock before reporting progress. No continuation or
 * provenance relation is created; reruns start from source identity zero. */
export async function transferCompetitionRetirementHistory(
  db: SqlExecutor,
  competitionId?: string,
  ctx: RequestContext = {},
  options: CompetitionHistoryTransferOptions = {}
): Promise<CompetitionHistoryParity[]> {
  if (ctx.connection)
    throw new Error('History transfer requires independent batch transactions');
  const batchSize = options.batchSize ?? 1000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error('History transfer batch size must be between 1 and 1000');
  const timerName = 'transferCompetitionRetirementHistory';
  ctx.timer?.start(timerName);
  try {
    const owners = await db.execute<TransferOwner>(
      `SELECT id,wave_id,legacy_wave_id FROM ${COMPETITIONS_TABLE} WHERE storage_mode='NATIVE'
       AND (:competitionId IS NULL OR id=:competitionId) ORDER BY id`,
      { competitionId: competitionId ?? null }
    );
    const reports: CompetitionHistoryParity[] = [];
    for (const owner of owners) {
      await transferVoteContext(db, owner, batchSize, ctx, options.onBatch);
      if (owner.legacy_wave_id === owner.wave_id) {
        const aggregate = await transferRetainedStream(
          db,
          owner,
          'AGGREGATE',
          batchSize,
          ctx,
          options.onBatch
        );
        const voter = await transferRetainedStream(
          db,
          owner,
          'VOTER',
          batchSize,
          ctx,
          options.onBatch
        );
        const activity = await scopeRetainedActivity(
          db,
          owner,
          batchSize,
          ctx,
          options.onBatch
        );
        await withOwnerLock(db, owner.id, ctx, (tx) =>
          preserveScheduledReceipts(db, owner.id, activity.cutoverAt, tx)
        );
        reports.push({
          competition_id: owner.id,
          aggregate_rows: aggregate,
          voter_rows: voter,
          activity_rows: activity.count
        });
      } else {
        const count = await transferNativeStreams(
          db,
          owner,
          batchSize,
          ctx,
          options.onBatch
        );
        reports.push({
          competition_id: owner.id,
          aggregate_rows: count,
          voter_rows: count,
          activity_rows: 0
        });
      }
    }
    return reports;
  } finally {
    ctx.timer?.stop(timerName);
  }
}

async function withOwnerLock<T>(
  db: SqlExecutor,
  id: string,
  ctx: RequestContext,
  action: (ctx: RequestContext) => Promise<T>
): Promise<T> {
  return db.executeNativeQueriesInTransaction(async (connection) => {
    const [owner] = await db.execute<{ id: string }>(
      `SELECT id FROM ${COMPETITIONS_TABLE} WHERE id=:id AND storage_mode='NATIVE' FOR UPDATE`,
      { id },
      { wrappedConnection: connection }
    );
    if (!owner) throw new Error(`Competition ownership changed: ${id}`);
    return action({ ...ctx, connection });
  });
}

async function transferVoteContext(
  db: SqlExecutor,
  owner: TransferOwner,
  batchSize: number,
  ctx: RequestContext,
  onBatch: CompetitionHistoryTransferOptions['onBatch']
): Promise<void> {
  let after = 0;
  while (true) {
    const page = await withOwnerLock(db, owner.id, ctx, async (tx) => {
      const options = { wrappedConnection: tx.connection };
      const params = {
        competitionId: owner.id,
        waveId: owner.wave_id,
        after,
        batchSize
      };
      const rows = await db.execute<{ sequence: number }>(
        `SELECT sequence FROM ${COMPETITION_VOTE_HISTORY_TABLE}
        WHERE competition_id=:competitionId AND sequence>:after ORDER BY sequence LIMIT :batchSize`,
        params,
        options
      );
      if (!rows.length) return [];
      const ids = rows.map((row) => Number(row.sequence));
      await db.execute(
        `UPDATE ${COMPETITION_VOTE_HISTORY_TABLE} history
        LEFT JOIN ${COMPETITION_ENTRIES_TABLE} entry ON entry.competition_id=history.competition_id AND entry.id=history.entry_id
        LEFT JOIN ${PROFILES_ACTIVITY_LOGS_TABLE} log ON log.id=CONCAT(history.competition_id,':',history.sequence)
          AND log.additional_data_2=:waveId AND log.type='DROP_VOTE_EDIT'
        SET history.drop_id=COALESCE(history.drop_id,entry.drop_id,log.target_id),
          history.submitter_id=COALESCE(history.submitter_id,entry.submitter_id,log.additional_data_1),
          history.proxy_id=COALESCE(history.proxy_id,log.proxy_id),history.contents=COALESCE(history.contents,log.contents)
        WHERE history.competition_id=:competitionId AND history.sequence IN (:ids)`,
        { ...params, ids },
        options
      );
      const [missing] = await db.execute<{ count: number | string }>(
        `SELECT COUNT(*) AS count FROM ${COMPETITION_VOTE_HISTORY_TABLE}
        WHERE competition_id=:competitionId AND sequence IN (:ids) AND drop_id IS NULL`,
        { ...params, ids },
        options
      );
      if (Number(missing.count))
        throw new Error(`Native vote context is incomplete for ${owner.id}`);
      return ids;
    });
    if (!page.length) break;
    after = page.at(-1)!;
    await onBatch?.({
      competition_id: owner.id,
      stream: 'VOTE_CONTEXT',
      rows: page.length,
      after
    });
    if (page.length < batchSize) break;
  }
}

async function transferRetainedStream(
  db: SqlExecutor,
  owner: TransferOwner,
  kind: HistoryKind,
  batchSize: number,
  ctx: RequestContext,
  onBatch: CompetitionHistoryTransferOptions['onBatch']
): Promise<number> {
  const table =
    kind === 'AGGREGATE'
      ? DROP_REAL_VOTE_IN_TIME_TABLE
      : DROP_REAL_VOTER_VOTE_IN_TIME_TABLE;
  const voter = kind === 'AGGREGATE' ? "''" : 'source.voter_id';
  let after = 0;
  while (true) {
    const page = await withOwnerLock(db, owner.id, ctx, async (tx) => {
      const dbOptions = { wrappedConnection: tx.connection };
      const params = {
        competitionId: owner.id,
        waveId: owner.wave_id,
        kind,
        batchSize,
        after
      };
      const ids = await db.execute<{ id: number }>(
        `SELECT id FROM ${table} WHERE wave_id=:waveId AND id>:after ORDER BY id LIMIT :batchSize`,
        params,
        dbOptions
      );
      if (!ids.length) return [];
      for (const row of ids)
        if (
          !Number.isSafeInteger(Number(row.id)) ||
          Number(row.id) >= NATIVE_SCORE_SEQUENCE_BASE
        )
          throw new Error(
            `Retained ${kind} history sequence exceeds reserved range for ${owner.id}`
          );
      const pageParams = { ...params, ids: ids.map((row) => Number(row.id)) };
      await db.execute(
        // Imported observations are immutable. An existing native identity or
        // snapshot must never be rewound from a stale physical source; the
        // exact comparison below fails closed on any conflicting wire value.
        `INSERT IGNORE INTO ${COMPETITION_SCORE_HISTORY_TABLE}
         (competition_id,kind,sequence,entry_id,drop_id,voter_profile_id,value,occurred_at)
         SELECT :competitionId,:kind,source.id,entry.id,source.drop_id,${voter},source.vote,source.timestamp
         FROM ${table} source LEFT JOIN ${COMPETITION_ENTRIES_TABLE} entry
           ON entry.competition_id=:competitionId AND entry.drop_id=source.drop_id
         WHERE source.wave_id=:waveId AND source.id IN (:ids)`,
        pageParams,
        dbOptions
      );
      const [parity] = await db.execute<{ mismatches: number | string }>(
        `SELECT COUNT(*) AS mismatches FROM ${table} source LEFT JOIN ${COMPETITION_SCORE_HISTORY_TABLE} target
          ON target.competition_id=:competitionId AND target.kind=:kind AND target.sequence=source.id
         WHERE source.wave_id=:waveId AND source.id IN (:ids) AND (target.sequence IS NULL OR NOT (
           target.drop_id<=>source.drop_id AND target.voter_profile_id<=>${voter}
           AND target.value<=>source.vote AND target.occurred_at<=>source.timestamp))`,
        pageParams,
        dbOptions
      );
      if (Number(parity.mismatches))
        throw new Error(
          `Retained ${kind} history parity failed for ${owner.id}`
        );
      return pageParams.ids;
    });
    if (!page.length) break;
    after = page.at(-1)!;
    await onBatch?.({
      competition_id: owner.id,
      stream: kind,
      rows: page.length,
      after
    });
    if (page.length < batchSize) break;
  }
  // A single consistent statement checks cardinality without holding the vote
  // lock. Reviewed prep writers and merges update both copies atomically.
  const [counts] = await db.execute<{
    source_count: number | string;
    target_count: number | string;
  }>(
    `SELECT (SELECT COUNT(*) FROM ${table} WHERE wave_id=:waveId) AS source_count,
      (SELECT COUNT(*) FROM ${COMPETITION_SCORE_HISTORY_TABLE}
       WHERE competition_id=:competitionId AND kind=:kind AND sequence<:base) AS target_count`,
    {
      competitionId: owner.id,
      waveId: owner.wave_id,
      kind,
      base: NATIVE_SCORE_SEQUENCE_BASE
    }
  );
  if (Number(counts.source_count) !== Number(counts.target_count))
    throw new Error(
      `Retained ${kind} history count parity failed for ${owner.id}`
    );
  return Number(counts.source_count);
}

async function transferNativeStreams(
  db: SqlExecutor,
  owner: TransferOwner,
  batchSize: number,
  ctx: RequestContext,
  onBatch: CompetitionHistoryTransferOptions['onBatch']
): Promise<number> {
  let after = 0;
  while (true) {
    const page = await withOwnerLock(db, owner.id, ctx, async (tx) => {
      const dbOptions = { wrappedConnection: tx.connection };
      const params = {
        competitionId: owner.id,
        after,
        batchSize,
        base: NATIVE_SCORE_SEQUENCE_BASE
      };
      const ids = await db.execute<{ sequence: number }>(
        `SELECT history.sequence FROM ${COMPETITION_VOTE_HISTORY_TABLE} history
         WHERE history.competition_id=:competitionId AND history.sequence>:after ORDER BY history.sequence LIMIT :batchSize`,
        params,
        dbOptions
      );
      if (!ids.length) return [];
      for (const row of ids)
        if (
          !Number.isSafeInteger(Number(row.sequence)) ||
          Number(row.sequence) >
            Number.MAX_SAFE_INTEGER - NATIVE_SCORE_SEQUENCE_BASE
        )
          throw new Error(
            `Native history sequence exceeds reserved safe-integer range for ${owner.id}`
          );
      const pageParams = {
        ...params,
        ids: ids.map((row) => Number(row.sequence))
      };
      for (const kind of ['AGGREGATE', 'VOTER'] as const)
        await transferNativeBatch(db, pageParams, kind, tx);
      return pageParams.ids;
    });
    if (!page.length) break;
    after = page.at(-1)!;
    await onBatch?.({
      competition_id: owner.id,
      stream: 'NATIVE',
      rows: page.length,
      after
    });
    if (page.length < batchSize) break;
  }
  const [counts] = await db.execute<{
    source_count: number | string;
    aggregate_count: number | string;
    voter_count: number | string;
  }>(
    `SELECT (SELECT COUNT(*) FROM ${COMPETITION_VOTE_HISTORY_TABLE} h
        WHERE h.competition_id=:competitionId) AS source_count,
      (SELECT COUNT(*) FROM ${COMPETITION_SCORE_HISTORY_TABLE} h
        WHERE h.competition_id=:competitionId AND h.kind='AGGREGATE') AS aggregate_count,
      (SELECT COUNT(*) FROM ${COMPETITION_SCORE_HISTORY_TABLE} h
        WHERE h.competition_id=:competitionId AND h.kind='VOTER') AS voter_count`,
    { competitionId: owner.id }
  );
  if (
    Number(counts.source_count) !== Number(counts.aggregate_count) ||
    Number(counts.source_count) !== Number(counts.voter_count)
  )
    throw new Error(`Native history count parity failed for ${owner.id}`);
  return Number(counts.source_count);
}

async function transferNativeBatch(
  db: SqlExecutor,
  params: { competitionId: string; base: number; ids: number[] },
  kind: HistoryKind,
  ctx: RequestContext
): Promise<void> {
  const options = { wrappedConnection: ctx.connection };
  const voter = kind === 'AGGREGATE' ? "''" : 'history.voter_profile_id';
  const value =
    kind === 'AGGREGATE' ? 'history.aggregate_value' : 'history.value';
  const pageParams = { ...params, kind };
  await db.execute(
    `INSERT IGNORE INTO ${COMPETITION_SCORE_HISTORY_TABLE}
     (competition_id,kind,sequence,entry_id,drop_id,voter_profile_id,value,occurred_at,mutation_sequence)
     SELECT history.competition_id,:kind,:base+history.sequence,history.entry_id,history.drop_id,
       ${voter},${value},history.occurred_at,history.sequence
     FROM ${COMPETITION_VOTE_HISTORY_TABLE} history WHERE history.competition_id=:competitionId AND history.sequence IN (:ids)`,
    pageParams,
    options
  );
  const [parity] = await db.execute<{ mismatches: number | string }>(
    `SELECT COUNT(*) AS mismatches FROM ${COMPETITION_VOTE_HISTORY_TABLE} history
     LEFT JOIN ${COMPETITION_SCORE_HISTORY_TABLE} target
       ON target.competition_id=history.competition_id AND target.kind=:kind AND target.sequence=:base+history.sequence
     WHERE history.competition_id=:competitionId AND history.sequence IN (:ids) AND (target.sequence IS NULL OR NOT (
       target.entry_id<=>history.entry_id AND target.drop_id<=>history.drop_id AND target.voter_profile_id<=>${voter}
       AND target.value<=>${value} AND target.occurred_at<=>history.occurred_at
       AND target.mutation_sequence<=>history.sequence))`,
    pageParams,
    options
  );
  if (Number(parity.mismatches))
    throw new Error(
      `Native ${kind} history parity failed for ${params.competitionId}`
    );
}

async function scopeRetainedActivity(
  db: SqlExecutor,
  owner: TransferOwner,
  batchSize: number,
  ctx: RequestContext,
  onBatch: CompetitionHistoryTransferOptions['onBatch']
) {
  const [state] = await db.execute<{ cutover_at: number | string | null }>(
    `SELECT cutover_at FROM ${COMPETITION_MIGRATIONS_TABLE}
     WHERE competition_id=:competitionId AND state IN ('NATIVE','ROLLBACK_REQUIRED')`,
    { competitionId: owner.id }
  );
  if (!state || state.cutover_at === null)
    throw new Error(
      `Retained primary has no completed ownership transfer: ${owner.id}`
    );
  // A wave's immutable shared vote log belongs to its original primary. This
  // includes accepted post-cutover logs from older writers without exact native
  // event IDs. Timestamp equality or migration audit labels never select rows.
  const params = { competitionId: owner.id, waveId: owner.wave_id, batchSize };
  let after = '';
  while (true) {
    // Shared-log scoping never locks the competition: it only fills an additive
    // log field and cannot change a current vote or profile activity payload.
    const page = await db.executeNativeQueriesInTransaction(
      async (connection) => {
        const options = { wrappedConnection: connection };
        const rows = await db.execute<{ id: string }>(
          `SELECT id FROM ${PROFILES_ACTIVITY_LOGS_TABLE} WHERE additional_data_2=:waveId AND type='DROP_VOTE_EDIT'
         AND id>:after ORDER BY id LIMIT :batchSize`,
          { ...params, after },
          options
        );
        if (!rows.length) return [];
        const ids = rows.map((row) => row.id);
        const [conflicts] = await db.execute<{ count: number | string }>(
          `SELECT COUNT(*) AS count FROM ${PROFILES_ACTIVITY_LOGS_TABLE}
           WHERE id IN (:ids) AND competition_id IS NOT NULL AND competition_id<>:competitionId`,
          { ...params, ids },
          options
        );
        if (Number(conflicts.count))
          throw new Error(
            `Shared vote Activity has conflicting ownership for ${owner.id}`
          );
        await db.execute(
          `UPDATE ${PROFILES_ACTIVITY_LOGS_TABLE} SET competition_id=:competitionId WHERE id IN (:ids)`,
          { ...params, ids },
          options
        );
        return ids;
      }
    );
    if (!page.length) break;
    after = page.at(-1)!;
    await onBatch?.({
      competition_id: owner.id,
      stream: 'ACTIVITY',
      rows: page.length,
      after
    });
    if (page.length < batchSize) break;
  }
  const [parity] = await db.execute<{
    count: number | string;
    mismatches: number | string;
  }>(
    `SELECT COUNT(*) AS count,COALESCE(SUM(NOT(competition_id<=>:competitionId)),0) AS mismatches
     FROM ${PROFILES_ACTIVITY_LOGS_TABLE} WHERE additional_data_2=:waveId AND type='DROP_VOTE_EDIT'`,
    params
  );
  if (Number(parity.mismatches))
    throw new Error(`Retained Activity parity failed for ${owner.id}`);
  return { count: Number(parity.count), cutoverAt: Number(state.cutover_at) };
}

async function preserveScheduledReceipts(
  db: SqlExecutor,
  competitionId: string,
  cutoverAt: number,
  ctx: RequestContext
): Promise<void> {
  const repository = new CompetitionRepository(() => db);
  const record = await repository.findCompetitionRecordById(competitionId, ctx);
  if (!record) throw new Error(`Competition not found: ${competitionId}`);
  const competition = await new NativeCompetitionReader(
    repository,
    ctx
  ).getCompetition(record, cutoverAt);
  const publishedAt = competition.published_at ?? competition.created_at;
  const starts = [
    competition.participation.starts_at,
    competition.voting.starts_at
  ].map((time) => Math.max(time ?? publishedAt, publishedAt));
  const startedAt = Math.min(...starts);
  if (startedAt <= cutoverAt)
    await preserveReceipt(
      db,
      competition,
      {
        key: 'started',
        eventType: 'COMPETITION_STARTED',
        occurredAt: startedAt,
        data: {}
      },
      cutoverAt,
      ctx
    );
  const boundaries = Array.from(
    new Set(
      [
        ...starts,
        competition.participation.ends_at,
        competition.voting.ends_at
      ].filter(
        (time): time is number =>
          time !== null && time >= publishedAt && time <= cutoverAt
      )
    )
  ).sort((a, b) => a - b);
  for (const boundary of boundaries)
    await preserveReceipt(
      db,
      competition,
      {
        key: `phase:${competition.config_version}:${boundary}`,
        eventType: 'COMPETITION_PHASE_CHANGED',
        occurredAt: boundary,
        data: {
          phase: computeCompetitionPhase(competition, boundary),
          config_version: competition.config_version
        }
      },
      cutoverAt,
      ctx
    );
}

async function preserveReceipt(
  db: SqlExecutor,
  competition: Competition,
  transition: {
    key: string;
    eventType: string;
    occurredAt: number;
    data: Record<string, unknown>;
  },
  completedAt: number,
  ctx: RequestContext
) {
  const { key, eventType, occurredAt, data } = transition;
  const id = stableUuid(competition.id, `event:${key}`);
  // Never acknowledge an existing pending native event: its effects remain due.
  await db.execute(
    `INSERT IGNORE INTO ${COMPETITION_OUTBOX_TABLE}
     (id,competition_id,wave_id,semantic_key,event,created_at,next_attempt_at,attempts,delivered_at)
     VALUES(:id,:competitionId,:waveId,:semanticKey,:event,:occurredAt,:occurredAt,0,:completedAt)`,
    {
      id,
      competitionId: competition.id,
      waveId: competition.wave_id,
      semanticKey: `${competition.id}:${key}`,
      event: JSON.stringify({
        event_id: id,
        event_version: 1,
        event_type: eventType,
        occurred_at: occurredAt,
        wave_id: competition.wave_id,
        competition_id: competition.id,
        data
      }),
      occurredAt,
      completedAt
    },
    { wrappedConnection: ctx.connection }
  );
}
