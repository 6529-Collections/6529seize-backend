import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_LEGACY_MIRROR_PERMITS_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROP_RANK_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  COMPETITION_VOTES_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  PROFILE_LATEST_LOG_TABLE
} from '@/constants';
import { SqlExecutor } from '@/sql-executor';
import { RequestContext } from '@/request.context';

/** The native owner can materialize old read models, but an old worker cannot.
 * This permit is transactional, scoped to one physical connection and one UUID,
 * and removed before commit. Session variables cannot leak to a reused pool. */
export async function withNativeLegacyMirror<T>(
  db: SqlExecutor,
  competitionId: string,
  ctx: RequestContext,
  action: () => Promise<T>
): Promise<T> {
  if (!ctx.connection)
    throw new Error(
      'Native compatibility materialization requires a transaction'
    );
  const options = { wrappedConnection: ctx.connection };
  const record = await db.oneOrNull<{
    storage_mode: string;
    legacy_wave_id: string | null;
  }>(
    `select storage_mode,legacy_wave_id from ${COMPETITIONS_TABLE} where id=:competitionId for update`,
    { competitionId },
    options
  );
  if (!record || record.storage_mode !== 'NATIVE')
    throw new Error(
      'Native ownership required for compatibility materialization'
    );
  if (record.legacy_wave_id === null) return action();
  await db.execute(
    `insert into ${COMPETITION_LEGACY_MIRROR_PERMITS_TABLE} (connection_id,competition_id,depth) values (connection_id(),:competitionId,1) on duplicate key update depth=depth+1`,
    { competitionId },
    options
  );
  try {
    return await action();
  } finally {
    await db.execute(
      `update ${COMPETITION_LEGACY_MIRROR_PERMITS_TABLE} set depth=depth-1 where connection_id=connection_id() and competition_id=:competitionId`,
      { competitionId },
      options
    );
    await db.execute(
      `delete from ${COMPETITION_LEGACY_MIRROR_PERMITS_TABLE} where connection_id=connection_id() and competition_id=:competitionId and depth=0`,
      { competitionId },
      options
    );
  }
}

/** Historical deltas stay available through old chart/download readers. All
 * state is derived from the committed native vote in the same transaction. */
export async function mirrorNativeLegacyVote(
  db: SqlExecutor,
  params: {
    competitionId: string;
    entryId: string;
    voterProfileId: string;
    previousVote: number;
    value: number;
    occurredAt: number;
  },
  ctx: RequestContext
): Promise<void> {
  const options = { wrappedConnection: ctx.connection };
  const row = await db.oneOrNull<{
    wave_id: string;
    drop_id: string;
    aggregate_value: number;
  }>(
    `select c.wave_id,e.drop_id,(select coalesce(sum(v.value),0) from ${COMPETITION_VOTES_TABLE} v where v.competition_id=c.id and v.entry_id=e.id) as aggregate_value from ${COMPETITIONS_TABLE} c join ${COMPETITION_ENTRIES_TABLE} e on e.competition_id=c.id and e.id=:entryId where c.id=:competitionId and c.legacy_wave_id=c.wave_id and c.storage_mode='NATIVE'`,
    params,
    options
  );
  if (!row) return;
  await withNativeLegacyMirror(db, params.competitionId, ctx, async () => {
    const values = {
      ...params,
      waveId: row.wave_id,
      dropId: row.drop_id,
      aggregate: Number(row.aggregate_value),
      delta: Math.abs(params.value) - Math.abs(params.previousVote)
    };
    await db.execute(
      `insert into ${DROP_VOTER_STATE_TABLE} (voter_id,drop_id,wave_id,votes) values (:voterProfileId,:dropId,:waveId,:value) on duplicate key update votes=:value`,
      values,
      options
    );
    await db.execute(
      `insert into ${DROP_RANK_TABLE} (drop_id,wave_id,vote,last_increased) values (:dropId,:waveId,:aggregate,:occurredAt) on duplicate key update vote=:aggregate,last_increased=if(:value>:previousVote,:occurredAt,last_increased)`,
      values,
      options
    );
    await db.execute(
      `insert into ${DROP_REAL_VOTE_IN_TIME_TABLE} (drop_id,wave_id,timestamp,vote) values (:dropId,:waveId,:occurredAt,:aggregate)`,
      values,
      options
    );
    await db.execute(
      `insert into ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} (drop_id,wave_id,voter_id,timestamp,vote) values (:dropId,:waveId,:voterProfileId,:occurredAt,:value)`,
      values,
      options
    );
    await db.execute(
      `insert into ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} (drop_id,wave_id,voter_id,created_at,credit_spent) values (:dropId,:waveId,:voterProfileId,:occurredAt,:delta)`,
      values,
      options
    );
  });
}

/** The log identity is also the public native Activity identity. This exact link
 * avoids matching distinct replacements by value or second-precision timestamps.
 * Only the immutable legacy primary can write wave-scoped compatibility logs. */
export async function mirrorNativeLegacyVoteActivity(
  db: SqlExecutor,
  params: {
    competitionId: string;
    entryId: string;
    voterProfileId: string;
    previousVote: number;
    value: number;
    occurredAt: number;
    proxyId?: string | null;
    reason?: string;
  },
  sequence: number,
  ctx: RequestContext
): Promise<void> {
  const timerName = 'mirrorNativeLegacyVoteActivity';
  ctx.timer?.start(timerName);
  try {
    const inserted = await db.execute(
      `INSERT INTO ${PROFILES_ACTIVITY_LOGS_TABLE}
       (id, profile_id, target_id, contents, type, proxy_id, created_at, additional_data_1, additional_data_2)
       SELECT :activityId, :voterProfileId, e.drop_id, :contents, 'DROP_VOTE_EDIT', :proxyId,
         DATE_ADD('1970-01-01', INTERVAL :occurredAt MICROSECOND), e.submitter_id, c.wave_id
       FROM ${COMPETITIONS_TABLE} c JOIN ${COMPETITION_ENTRIES_TABLE} e
         ON e.competition_id = c.id AND e.id = :entryId
       WHERE c.id = :competitionId AND c.legacy_wave_id = c.wave_id AND c.storage_mode = 'NATIVE'`,
      {
        ...params,
        occurredAt: params.occurredAt * 1000,
        activityId: `${params.competitionId}:${sequence}`,
        proxyId: params.proxyId ?? null,
        contents: JSON.stringify({
          oldVote: params.previousVote,
          newVote: params.value,
          ...(params.reason ? { reason: params.reason } : {})
        })
      },
      { wrappedConnection: ctx.connection }
    );
    if (db.getAffectedRows(inserted)) {
      await db.execute(
        `INSERT INTO ${PROFILE_LATEST_LOG_TABLE} (profile_id, latest_activity)
         VALUES (:voterProfileId, DATE_ADD('1970-01-01', INTERVAL :occurredAt MICROSECOND))
         ON DUPLICATE KEY UPDATE latest_activity = GREATEST(latest_activity, VALUES(latest_activity))`,
        {
          voterProfileId: params.voterProfileId,
          occurredAt: params.occurredAt * 1000
        },
        { wrappedConnection: ctx.connection }
      );
    }
  } finally {
    ctx.timer?.stop(timerName);
  }
}

/** Shared drop identity/content is retained. Only the old classification/cache
 * is materialized; decision effects remain owned by the native outbox. */
export async function mirrorNativeLegacyWinners(
  db: SqlExecutor,
  competitionId: string,
  dropIds: readonly string[],
  ctx: RequestContext
): Promise<void> {
  if (!dropIds.length) return;
  const options = { wrappedConnection: ctx.connection };
  const primary = await db.oneOrNull<{ wave_id: string }>(
    `select wave_id from ${COMPETITIONS_TABLE} where id=:competitionId and legacy_wave_id=wave_id and storage_mode='NATIVE'`,
    { competitionId },
    options
  );
  if (!primary) return;
  await withNativeLegacyMirror(db, competitionId, ctx, async () => {
    const { DROPS_TABLE, WAVE_LEADERBOARD_ENTRIES_TABLE } =
      await import('@/constants');
    await db.execute(
      `update ${DROPS_TABLE} set drop_type='WINNER' where wave_id=:waveId and id in (:dropIds)`,
      { waveId: primary.wave_id, dropIds },
      options
    );
    await db.execute(
      `delete from ${DROP_RANK_TABLE} where wave_id=:waveId and drop_id in (:dropIds)`,
      { waveId: primary.wave_id, dropIds },
      options
    );
    await db.execute(
      `delete from ${WAVE_LEADERBOARD_ENTRIES_TABLE} where wave_id=:waveId and drop_id in (:dropIds)`,
      { waveId: primary.wave_id, dropIds },
      options
    );
  });
}

export async function mirrorNativeLegacySchedule(
  db: SqlExecutor,
  competitionId: string,
  next: number | null,
  ctx: RequestContext
): Promise<void> {
  const { WAVES_TABLE } = await import('@/constants');
  const options = { wrappedConnection: ctx.connection };
  const primary = await db.oneOrNull<{ wave_id: string }>(
    `select wave_id from ${COMPETITIONS_TABLE} where id=:competitionId and legacy_wave_id=wave_id and storage_mode='NATIVE'`,
    { competitionId },
    options
  );
  if (primary)
    await withNativeLegacyMirror(db, competitionId, ctx, () =>
      db.execute(
        `update ${WAVES_TABLE} set next_decision_time=:next where id=:waveId`,
        { waveId: primary.wave_id, next },
        options
      )
    );
}
