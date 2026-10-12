import { DataSource } from 'typeorm';
import { getDataSource } from '@/db';
import * as MigrationEntities from '@/entities/ICompetitionMigration';
import { dbSupplier } from '@/sql-executor';
import {
  COMPETITION_PAUSES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE
} from '@/constants';
import { withMigrationSchemaConnection } from './competition-migration-schema';
import { installLegacyCompetitionGetFacade } from './legacy-competition-get-facade';
import { installMigrationCapture } from './competition-migration-capture';
import { CompetitionRepository } from './competition.repository';
import { WavesApiDb } from '@/api/waves/waves.api.db';
import { legacyCompetitionId } from './competition-id';

/** Local setup creates missing migration tables and adds nullable fields only.
 * It never runs broad entity synchronization or unrelated migrations. */
export async function prepareLocalMigration(waveId: string): Promise<void> {
  if (
    process.env.NODE_ENV !== 'local' ||
    !['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST ?? '') ||
    !['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST_READ ?? '')
  )
    throw new Error(
      'Automatic migration setup requires loopback local read/write databases'
    );
  const record = await new CompetitionRepository().findCompetitionRecordById(
    legacyCompetitionId(waveId),
    {}
  );
  if (record?.storage_mode === 'NATIVE') return;
  const wave = await new WavesApiDb(dbSupplier).findWaveById(waveId);
  if (!wave || wave.type === 'CHAT')
    throw new Error('Wave has no legacy competition');
  const source = new DataSource({
    ...getDataSource().options,
    entities: Object.values(MigrationEntities),
    synchronize: false,
    logging: false
  });
  await source.initialize();
  try {
    const plan = await source.driver.createSchemaBuilder().log();
    if (
      plan.upQueries.some(
        (query) => !/^CREATE (TABLE|(?:UNIQUE )?INDEX)\b/i.test(query.query)
      )
    )
      throw new Error(
        'Existing migration schema differs from entity definitions; automatic setup refuses alterations'
      );
    const db = dbSupplier();
    await withMigrationSchemaConnection(db, async ({ connection }) => {
      const options = { wrappedConnection: connection };
      for (const query of plan.upQueries)
        await db.execute(query.query, {}, options);
      for (const [table, column] of [
        [COMPETITION_PAUSES_TABLE, 'legacy_source_id'],
        [COMPETITION_LEADERBOARD_ENTRIES_TABLE, 'ordering_time'],
        [COMPETITION_LEADERBOARD_ENTRIES_TABLE, 'decision_rating']
      ]) {
        const existing = await db.oneOrNull<{ count: number }>(
          'select count(*) as count from information_schema.COLUMNS where TABLE_SCHEMA=database() and TABLE_NAME=:table and COLUMN_NAME=:column',
          { table, column },
          options
        );
        if (!Number(existing?.count ?? 0))
          await db.execute(
            `alter table \`${table}\` add column \`${column}\` bigint null`,
            {},
            options
          );
      }
    });
    await installLegacyCompetitionGetFacade(db);
    await installMigrationCapture(db);
    // Existing mappings may already hold a completed backfill checkpoint.
    // Re-ensuring one would edit its config/version and break resumable parity.
    if (!record)
      await new CompetitionRepository().ensureLegacyMappingForWave(wave, {});
  } finally {
    await source.destroy();
  }
}
