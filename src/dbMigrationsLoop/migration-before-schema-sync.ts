import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DataSource } from 'typeorm';

type MigrationQuery = (sql: string, parameters?: unknown[]) => Promise<unknown>;

/**
 * Runs a db-migrate migration's `up` on the primary before entity sync. Used
 * for column changes TypeORM would make by dropping and re-adding the column.
 * db-migrate runs the same file again after sync; it must then be a no-op.
 */
export async function runMigrationBeforeSchemaSync(
  filename: string,
  source: DataSource
): Promise<void> {
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
