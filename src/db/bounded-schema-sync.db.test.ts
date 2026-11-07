import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  DISTRIBUTION_NORMALIZED_TABLE,
  EXTERNAL_INDEXED_TRANSFERS_TABLE,
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
