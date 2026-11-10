import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  DISTRIBUTION_NORMALIZED_TABLE,
  EXTERNAL_INDEXED_TRANSFERS_TABLE,
  IDENTITY_TDH_SYNC_SCOPE_TABLE,
  IDENTITY_TDH_SYNC_STATE_TABLE,
  COMPETITION_SCORE_RESETS_TABLE,
  COMPETITION_SCORE_RESET_STATE_TABLE,
  MARKET_DEPTH_EVENTS_TABLE,
  NFTS_HISTORY_REPLAY_JOBS_TABLE
} from '@/constants';
import * as Entities from '@/entities/entities';
import { sqlExecutor } from '@/sql-executor';
import {
  SCHEMA_SYNC_ATTEMPTS,
  synchronizeSchemaBounded
} from './bounded-schema-sync';

const noSleep = async () => undefined;
const TOUCHED_TABLES = [
  EXTERNAL_INDEXED_TRANSFERS_TABLE,
  DISTRIBUTION_NORMALIZED_TABLE,
  MARKET_DEPTH_EVENTS_TABLE,
  NFTS_HISTORY_REPLAY_JOBS_TABLE
];

let dataSource: DataSource;

async function plannedStatements(): Promise<string[]> {
  const plan = await dataSource.driver.createSchemaBuilder().log();
  return plan.upQueries.map((it) => it.query);
}

/** Table definitions and TypeORM's bookkeeping, as synchronization left them. */
async function schemaSnapshot() {
  const tables: Record<string, string> = {};
  for (const table of TOUCHED_TABLES) {
    const [row] = await sqlExecutor.execute<Record<string, string>>(
      `show create table \`${table}\``
    );
    tables[table] = row['Create Table'];
  }
  const metadata = await sqlExecutor.execute(
    `select type, \`table\`, name, value from typeorm_metadata
     order by \`table\`, name`
  );
  return { tables, metadata };
}

/**
 * Schema drift synchronize() must repair: a missing table, a missing column,
 * a changed column, a missing index, and a generated column whose recorded
 * expression is stale (TypeORM drops and recreates it and rewrites its row
 * in typeorm_metadata).
 */
async function drift() {
  for (const sql of [
    `drop table \`${NFTS_HISTORY_REPLAY_JOBS_TABLE}\``,
    `alter table \`${EXTERNAL_INDEXED_TRANSFERS_TABLE}\` drop column sale_epoch_start`,
    `alter table \`${EXTERNAL_INDEXED_TRANSFERS_TABLE}\` modify is_monetary_sale int null`,
    `drop index idx_missing_info on \`${DISTRIBUTION_NORMALIZED_TABLE}\``,
    `update typeorm_metadata set value = 'stale' where \`table\` = '${MARKET_DEPTH_EVENTS_TABLE}' and name = 'occurred_at'`
  ]) {
    await sqlExecutor.execute(sql);
  }
}

describe('synchronizeSchemaBounded on MySQL', () => {
  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'mysql',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      charset: 'utf8mb4',
      timezone: 'Etc/UTC',
      logging: false,
      entities: Object.values(Entities).filter(
        (entity) => typeof entity === 'function'
      )
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    // Leave the schema exactly as the entities define it.
    await synchronizeSchemaBounded(dataSource, { sleep: noSleep });
    await dataSource.destroy();
  });

  it('plans no statements for a synchronized schema', async () => {
    await expect(plannedStatements()).resolves.toEqual([]);
  });

  it('repairs drift exactly as synchronize() does', async () => {
    await drift();
    await dataSource.synchronize();
    const bySynchronize = await schemaSnapshot();

    await drift();
    const result = await synchronizeSchemaBounded(dataSource, {
      sleep: noSleep
    });

    expect(result.applied).toBe(result.planned);
    expect(result.planned).toBeGreaterThan(5);
    expect(await schemaSnapshot()).toEqual(bySynchronize);
    await expect(plannedStatements()).resolves.toEqual([]);
  }, 60_000);

  it('adds the identities sync marker table with one CREATE TABLE and nothing else', async () => {
    await sqlExecutor.execute(
      `drop table \`${IDENTITY_TDH_SYNC_STATE_TABLE}\``
    );

    const planned = await plannedStatements();
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatch(
      new RegExp(`^CREATE TABLE \`${IDENTITY_TDH_SYNC_STATE_TABLE}\``)
    );

    const result = await synchronizeSchemaBounded(dataSource, {
      sleep: noSleep
    });
    expect(result).toEqual({ planned: 1, applied: 1 });
    await expect(plannedStatements()).resolves.toEqual([]);
  });

  it.each([
    COMPETITION_SCORE_RESETS_TABLE,
    COMPETITION_SCORE_RESET_STATE_TABLE
  ])('adds %s with one additive CREATE TABLE', async (table) => {
    await sqlExecutor.execute(`drop table \`${table}\``);
    const planned = await plannedStatements();
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatch(new RegExp(`^CREATE TABLE \`${table}\``));
    expect(
      await synchronizeSchemaBounded(dataSource, { sleep: noSleep })
    ).toEqual({ planned: 1, applied: 1 });
    expect(await plannedStatements()).toEqual([]);
  });

  it('upgrades an existing identities sync marker table with one ADD COLUMN and nothing else', async () => {
    // The table as the first release created it, before walk_after.
    await sqlExecutor.execute(
      `alter table \`${IDENTITY_TDH_SYNC_STATE_TABLE}\` drop column walk_after`
    );

    const planned = await plannedStatements();
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatch(
      new RegExp(
        `^ALTER TABLE \`${IDENTITY_TDH_SYNC_STATE_TABLE}\` ADD \`walk_after\``
      )
    );

    const result = await synchronizeSchemaBounded(dataSource, {
      sleep: noSleep
    });
    expect(result).toEqual({ planned: 1, applied: 1 });
    await expect(plannedStatements()).resolves.toEqual([]);
  });

  it('upgrades the identities sync tables from the previous release with one CREATE TABLE and one ADD COLUMN', async () => {
    // As the previous release left them: no scope table, no ratings_since.
    await sqlExecutor.execute(
      `drop table \`${IDENTITY_TDH_SYNC_SCOPE_TABLE}\``
    );
    await sqlExecutor.execute(
      `alter table \`${IDENTITY_TDH_SYNC_STATE_TABLE}\` drop column ratings_since`
    );

    const planned = await plannedStatements();
    expect(planned).toHaveLength(2);
    expect(planned).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          new RegExp(`^CREATE TABLE \`${IDENTITY_TDH_SYNC_SCOPE_TABLE}\``)
        ),
        expect.stringMatching(
          new RegExp(
            `^ALTER TABLE \`${IDENTITY_TDH_SYNC_STATE_TABLE}\` ADD \`ratings_since\``
          )
        )
      ])
    );

    const result = await synchronizeSchemaBounded(dataSource, {
      sleep: noSleep
    });
    expect(result).toEqual({ planned: 2, applied: 2 });
    await expect(plannedStatements()).resolves.toEqual([]);
  });

  it('converges after a run stopped between a generated column change and its bookkeeping', async () => {
    const before = await schemaSnapshot();
    // State left by a run that dropped the column's index and changed the
    // column, then failed before updating typeorm_metadata.
    await sqlExecutor.execute(
      `drop index idx_market_depth_events_occurred on \`${MARKET_DEPTH_EVENTS_TABLE}\``
    );
    await sqlExecutor.execute(
      `update typeorm_metadata set value = 'stale' where \`table\` = '${MARKET_DEPTH_EVENTS_TABLE}' and name = 'occurred_at'`
    );
    const result = await synchronizeSchemaBounded(dataSource, {
      sleep: noSleep
    });
    expect(result.planned).toBeGreaterThan(0);
    expect(result.applied).toBe(result.planned);
    expect(await schemaSnapshot()).toEqual(before);
    await expect(plannedStatements()).resolves.toEqual([]);
  }, 60_000);

  it('gives up on a table held by a running transaction instead of queueing behind it', async () => {
    await sqlExecutor.execute(
      `drop index idx_missing_info on \`${DISTRIBUTION_NORMALIZED_TABLE}\``
    );
    let finishReader!: () => void;
    const readerDone = new Promise<void>((resolve) => (finishReader = resolve));
    let readerStarted!: () => void;
    const started = new Promise<void>((resolve) => (readerStarted = resolve));
    // An open transaction that has read the table holds its metadata lock.
    const reader = sqlExecutor.executeNativeQueriesInTransaction(
      async (connection) => {
        await sqlExecutor.execute(
          `select count(*) from \`${DISTRIBUTION_NORMALIZED_TABLE}\``,
          {},
          { wrappedConnection: connection }
        );
        readerStarted();
        await readerDone;
      }
    );
    await started;
    try {
      await expect(
        synchronizeSchemaBounded(dataSource, { sleep: noSleep })
      ).rejects.toThrow(
        `Schema change on ${DISTRIBUTION_NORMALIZED_TABLE} stayed locked after ${SCHEMA_SYNC_ATTEMPTS} attempts`
      );
    } finally {
      finishReader();
      await reader;
    }
    // The next run plans again from the live schema and finishes the job.
    await expect(
      synchronizeSchemaBounded(dataSource, { sleep: noSleep })
    ).resolves.toEqual({ planned: 1, applied: 1 });
    await expect(plannedStatements()).resolves.toEqual([]);
  }, 60_000);
});
