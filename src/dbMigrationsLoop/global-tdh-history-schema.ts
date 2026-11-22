import type { DataSource } from 'typeorm';
import { getDataSource } from '@/db';
import { runMigrationBeforeSchemaSync } from './migration-before-schema-sync';

export async function widenGlobalTdhHistoryBeforeSchemaSync(
  source: DataSource = getDataSource()
): Promise<void> {
  await runMigrationBeforeSchemaSync(
    '20261113065624-widen-global-tdh-history-values.js',
    source
  );
}
