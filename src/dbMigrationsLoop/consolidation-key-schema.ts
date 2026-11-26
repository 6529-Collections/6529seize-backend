import type { DataSource } from 'typeorm';
import { getDataSource } from '@/db';
import { runMigrationBeforeSchemaSync } from './migration-before-schema-sync';

/** Widens every consolidation key column to fit a 16-wallet identity. */
export async function widenConsolidationKeysBeforeSchemaSync(
  source: DataSource = getDataSource()
): Promise<void> {
  await runMigrationBeforeSchemaSync(
    '20261122010000-widen-consolidation-keys.js',
    source
  );
}
