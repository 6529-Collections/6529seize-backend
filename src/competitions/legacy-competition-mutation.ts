import { dbSupplier } from '@/sql-executor';
import { appFeatures } from '@/app-features';
import { ForbiddenException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import {
  CompetitionRecord,
  competitionRepository
} from './competition.repository';
import { withNativeLegacyMirror } from './legacy-competition-mirror';
import {
  withLegacyCompetitionGetFacade,
  withoutLegacyCompetitionGetFacade
} from './legacy-competition-get-facade';

/** Every old primary command locks before touching its wave/drop/vote rows.
 * Validation reads the native projection after transfer. Mirrored writes and
 * forward reconciliation remain one transaction and cannot change ownership. */
export async function withLegacyPrimaryMutation<T>(
  waveId: string,
  ctx: RequestContext,
  action: (native: CompetitionRecord | null) => Promise<T>
): Promise<T> {
  const record = await competitionRepository.lockLegacyExecutionOwner(
    waveId,
    ctx
  );
  if (record?.storage_mode !== 'NATIVE') return action(null);
  return withNativeLegacyMirror(dbSupplier(), record.id, ctx, () =>
    withLegacyCompetitionGetFacade(() => action(record))
  );
}

export function readLegacyMutationSource<T>(action: () => T): T {
  return withoutLegacyCompetitionGetFacade(action);
}

/** Old configuration commands retain their existing relation validation. Their
 * accepted result becomes a new native configuration version in the same tx. */
export async function reconcileAcceptedLegacySettings(
  record: CompetitionRecord,
  actor: string,
  ctx: RequestContext
): Promise<void> {
  if (!appFeatures.isNativeCompetitionWritesEnabled())
    throw new ForbiddenException(
      'Competition changes are temporarily unavailable'
    );
  const { CompetitionMigrationBackfill } =
    await import('./competition-migration-backfill');
  const { NativeCompetitionReader } =
    await import('./native-competition.reader');
  const { migrationCommandConfiguration } =
    await import('./legacy-competition-configuration');
  const {
    COMPETITION_CONFIG_VERSIONS_TABLE,
    COMPETITIONS_TABLE,
    COMPETITION_OUTCOMES_TABLE,
    COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE
  } = await import('@/constants');
  const db = dbSupplier(),
    options = { wrappedConnection: ctx.connection },
    backfill = new CompetitionMigrationBackfill(db),
    now = Date.now();
  await readLegacyMutationSource(async () => {
    for (const table of [
      COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
      COMPETITION_OUTCOMES_TABLE
    ]) {
      const count = await db.oneOrNull<{ count: number }>(
        `select count(*) as count from ${table} where competition_id=:id`,
        { id: record.id },
        options
      );
      if (Number(count?.count ?? 0) > 1000)
        throw new Error(
          'OWNED_EXCEPTION: settings command requires a bounded native outcome adapter'
        );
      await db.execute(
        `delete from ${table} where competition_id=:id`,
        { id: record.id },
        options
      );
    }
    await backfill.batch(record, 'CONFIGURATION', 0, 100, now, null, ctx);
    await backfill.batch(record, 'OUTCOMES', 0, 100, now, null, ctx);
  });
  const c = await new NativeCompetitionReader(
    competitionRepository,
    ctx
  ).getCompetition(record, now);
  const config = migrationCommandConfiguration(c),
    version = Number(record.config_version) + 1;
  await db.execute(
    `update ${COMPETITIONS_TABLE} set config_version=:version where id=:id`,
    { id: record.id, version },
    options
  );
  await db.execute(
    `insert into ${COMPETITION_CONFIG_VERSIONS_TABLE} (competition_id,version,config,created_by,created_at) values (:id,:version,:config,:actor,:now)`,
    { id: record.id, version, config: JSON.stringify(config), actor, now },
    options
  );
}

export async function reconcileAcceptedLegacyPauses(
  record: CompetitionRecord,
  ctx: RequestContext
): Promise<void> {
  if (!appFeatures.isNativeCompetitionWritesEnabled())
    throw new ForbiddenException(
      'Competition changes are temporarily unavailable'
    );
  const { COMPETITION_PAUSES_TABLE, WAVES_DECISION_PAUSES_TABLE } =
    await import('@/constants');
  const { legacyCompetitionPauseId } = await import('./competition-id');
  const db = dbSupplier(),
    options = { wrappedConnection: ctx.connection };
  const rows = await readLegacyMutationSource(() =>
    db.execute<{
      id: number;
      start_time: number;
      end_time: number;
      reason: string | null;
    }>(
      `select * from ${WAVES_DECISION_PAUSES_TABLE} where wave_id=:waveId order by id limit 1001`,
      { waveId: record.wave_id },
      options
    )
  );
  if (rows.length > 1000)
    throw new Error(
      'OWNED_EXCEPTION: pause command requires a bounded adapter'
    );
  await db.execute(
    `delete from ${COMPETITION_PAUSES_TABLE} where competition_id=:id`,
    { id: record.id },
    options
  );
  for (const row of rows)
    await db.execute(
      `insert into ${COMPETITION_PAUSES_TABLE} (id,competition_id,start_time,end_time,reason,legacy_source_id) values (:id,:competitionId,:start,:end,:reason,:sourceId)`,
      {
        id: legacyCompetitionPauseId(record.id, row.id),
        competitionId: record.id,
        start: Number(row.start_time),
        end: Number(row.end_time),
        reason: row.reason,
        sourceId: row.id
      },
      options
    );
}
