import * as os from 'node:os';
import * as mysql from 'mysql';
import { sqlExecutor } from '@/sql-executor';

export const TEST_DB_NAME_PREFIX_ENV = 'TEST_DB_NAME_PREFIX';

const IGNORED_TABLES = ['migrations', 'typeorm_metadata'];

function getAvailableParallelism(): number {
  return typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
}

function getMaxWorkersFromConfig(globalConfig: unknown): number | null {
  if (
    globalConfig &&
    typeof globalConfig === 'object' &&
    'maxWorkers' in globalConfig
  ) {
    const raw = (globalConfig as { maxWorkers?: unknown }).maxWorkers;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.floor(raw);
    }
  }

  return null;
}

export function getTestDatabaseNamePrefix(baseDatabaseName: string): string {
  return `${baseDatabaseName}_jest_worker`;
}

export function getWorkerDatabaseName(
  workerId: string | number,
  prefix = process.env[TEST_DB_NAME_PREFIX_ENV]
): string {
  if (!prefix) {
    throw new Error(
      `Expected ${TEST_DB_NAME_PREFIX_ENV} to be configured for test database selection`
    );
  }

  return `${prefix}_${workerId}`;
}

export function getTestWorkerCount(globalConfig?: unknown): number {
  return (
    getMaxWorkersFromConfig(globalConfig) ??
    Math.max(1, Math.ceil(getAvailableParallelism() / 2))
  );
}

export function selectWorkerDatabaseFromEnv(): string {
  const workerId = process.env.JEST_WORKER_ID ?? '1';
  const databaseName = getWorkerDatabaseName(workerId);
  process.env.DB_NAME = databaseName;
  return databaseName;
}

export async function provisionWorkerDatabases({
  executeRootQuery,
  appUser,
  databasePrefix,
  workerCount
}: {
  executeRootQuery: (query: string) => Promise<unknown>;
  appUser: string;
  databasePrefix: string;
  workerCount: number;
}): Promise<void> {
  for (let workerId = 1; workerId <= workerCount; workerId++) {
    const databaseName = getWorkerDatabaseName(workerId, databasePrefix);
    await executeRootQuery(
      `CREATE DATABASE IF NOT EXISTS ${mysql.escapeId(
        databaseName
      )} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await executeRootQuery(
      `GRANT ALL PRIVILEGES ON ${mysql.escapeId(
        databaseName
      )}.* TO ${mysql.escape(appUser)}@'%'`
    );
  }
  await executeRootQuery('FLUSH PRIVILEGES');
}

export async function resetTestDatabase(): Promise<void> {
  const databaseName = process.env.DB_NAME;
  if (!databaseName) {
    throw new Error(
      'Expected DB_NAME to be configured before resetting test DB'
    );
  }

  const tables = await sqlExecutor
    .execute<{ table_name?: string; TABLE_NAME?: string }>(
      `
        SELECT table_name AS table_name
        FROM information_schema.tables
        WHERE table_schema = :databaseName
          AND table_type = 'BASE TABLE'
          AND table_name NOT IN (:ignoredTables)
      `,
      {
        databaseName,
        ignoredTables: IGNORED_TABLES
      }
    )
    .then((results) =>
      results
        .map((row) => row.table_name ?? row.TABLE_NAME)
        .filter((table): table is string => Boolean(table))
    );

  if (!tables.length) {
    return;
  }

  for (const table of tables) {
    await sqlExecutor.execute(`TRUNCATE TABLE ${mysql.escapeId(table)}`);
  }
}
