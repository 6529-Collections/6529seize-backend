import path from 'node:path';
import type { DataSource } from 'typeorm';
import { getDataSource } from '@/db';

type MigrationQuery = (sql: string, parameters?: unknown[]) => Promise<unknown>;

export async function widenGlobalTdhHistoryBeforeSchemaSync(
  source: DataSource = getDataSource()
): Promise<void> {
  // The Lambda package copies migrations alongside the bundled entry point.
  const migration = require(
    path.resolve('migrations/20261113065624-widen-global-tdh-history-values.js')
  ) as {
    up: (db: { runSql: MigrationQuery }) => Promise<void>;
  };
  const runner = source.createQueryRunner('master');
  try {
    const query: MigrationQuery = (sql, parameters) =>
      runner.query(sql, parameters);
    await migration.up({ runSql: query });
  } finally {
    await runner.release();
  }
}
