import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DataSource } from 'typeorm';
import { getDataSource } from '@/db';

type MigrationQuery = (sql: string, parameters?: unknown[]) => Promise<unknown>;

export async function widenGlobalTdhHistoryBeforeSchemaSync(
  source: DataSource = getDataSource()
): Promise<void> {
  const filename = '20261113065624-widen-global-tdh-history-values.js';
  // The Lambda ZIP places migrations beside index.js. Source runs use the repo root.
  const packaged = path.join(__dirname, 'migrations', filename);
  const migrationPath = existsSync(packaged)
    ? packaged
    : path.resolve(__dirname, '../../migrations', filename);
  const migration = require(migrationPath) as {
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
