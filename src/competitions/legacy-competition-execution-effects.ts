import { randomUUID } from 'node:crypto';
import {
  COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE,
  COMPETITION_MIGRATIONS_TABLE
} from '@/constants';
import { dbSupplier } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { legacyCompetitionId, stableUuid } from '@/competitions/competition-id';
import { CompetitionLegacyExecutionEffectsEntity } from '@/entities/ICompetitionMigration';
import { enqueueClaimBuild } from '@/waves/claims-builder-publisher';
import { sendIdentityPushNotificationsStrict } from '@/api/push-notifications/push-notifications.service';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from '@/api/waves/wave-score.service';

export async function recordLegacyExecutionEffects(
  waveId: string,
  decisionTime: number,
  payload: CompetitionLegacyExecutionEffectsEntity['payload'],
  ctx: RequestContext
): Promise<string | null> {
  if (!ctx.connection)
    throw new Error('Legacy execution effects must commit with the decision');
  const db = dbSupplier(),
    competitionId = legacyCompetitionId(waveId),
    options = { wrappedConnection: ctx.connection };
  const enrolled = await db.oneOrNull<{ competition_id: string }>(
    `select competition_id from ${COMPETITION_MIGRATIONS_TABLE} where competition_id=:competitionId`,
    { competitionId },
    options
  );
  if (!enrolled) return null;
  const id = stableUuid(competitionId, `legacy-effects:${decisionTime}`);
  await db.execute(
    `insert into ${COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE} (id,competition_id,wave_id,payload,attempts,created_at) values(:id,:competitionId,:waveId,:payload,0,:now) on duplicate key update id=id`,
    {
      id,
      competitionId,
      waveId,
      payload: JSON.stringify(payload),
      now: Date.now()
    },
    options
  );
  return id;
}

/** Delivery retries keep stable claim/drop and notification identities. A
 * committed decision with unfinished publication always prevents cutover. */
export async function deliverLegacyExecutionEffects(id: string): Promise<void> {
  const db = dbSupplier();
  const token = randomUUID();
  let leaseUntil = Date.now() + 240000;
  const row = await db.executeNativeQueriesInTransaction(
    async (connection) => {
      const options = { wrappedConnection: connection };
      const candidate =
        await db.oneOrNull<CompetitionLegacyExecutionEffectsEntity>(
          `select * from ${COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE} where id=:id for update`,
          { id },
          options
        );
      if (!candidate || candidate.completed_at !== null) return null;
      if (
        candidate.lease_until !== null &&
        Number(candidate.lease_until) > Date.now()
      )
        throw new Error('Legacy execution publication is already in flight');
      await db.execute(
        `update ${COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE} set lease_token=:token,lease_until=:until,attempts=attempts+1 where id=:id`,
        { id, token, until: leaseUntil },
        options
      );
      return candidate;
    },
    { isolationLevel: 'READ COMMITTED' }
  );
  if (!row) return;
  const payload =
    typeof row.payload === 'string'
      ? (JSON.parse(
          row.payload
        ) as CompetitionLegacyExecutionEffectsEntity['payload'])
      : row.payload;
  const renew = async () => {
    leaseUntil = Math.max(Date.now() + 240000, leaseUntil + 1);
    const updated = await db.execute(
      `update ${COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE} set lease_until=:until where id=:id and lease_token=:token and completed_at is null and lease_until>:now`,
      { id, token, until: leaseUntil, now: Date.now() }
    );
    if (db.getAffectedRows(updated) !== 1)
      throw new Error('Legacy effect lease lost; publication stopped');
  };
  try {
    await renew();
    if (payload.dirtyWaveIds.length)
      await waveScoreService.requestWaveScoreRefreshBestEffort(
        payload.dirtyWaveIds,
        WaveScoreDirtyRefreshReason.DROP_CHANGED,
        {}
      );
    await renew();
    if (payload.claimDropId) await enqueueClaimBuild(payload.claimDropId);
    await renew();
    await sendIdentityPushNotificationsStrict(payload.pushIds);
    await db.execute(
      `update ${COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE} set completed_at=:now,lease_until=null,lease_token=null where id=:id and lease_token=:token`,
      { id, token, now: Date.now() }
    );
  } catch (error) {
    await db.execute(
      `update ${COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE} set lease_until=null,lease_token=null where id=:id and lease_token=:token`,
      { id, token }
    );
    throw error;
  }
}

export async function retryLegacyExecutionEffects(
  competitionId?: string
): Promise<void> {
  const rows = await dbSupplier().execute<{ id: string }>(
    `select id from ${COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE} where completed_at is null and (lease_until is null or lease_until<=:now) ${competitionId ? 'and competition_id=:competitionId' : ''} order by created_at,id limit 100`,
    { competitionId, now: Date.now() }
  );
  const failures: unknown[] = [];
  for (const row of rows) {
    try {
      await deliverLegacyExecutionEffects(row.id);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new Error(
      'Legacy execution publication remains pending; cutover is blocked'
    );
}
