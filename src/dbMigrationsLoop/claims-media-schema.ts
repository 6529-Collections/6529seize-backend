import type { DataSource, TableColumn } from 'typeorm';
import { getDataSource } from '@/db';
import { MINTING_CLAIMS_TABLE } from '@/constants';

const DEFINITIONS = [
  { name: 'media_upload_lease_token', type: 'varchar', length: '36' },
  { name: 'media_upload_lease_until', type: 'bigint', length: '' }
] as const;

function compatible(
  column: TableColumn,
  definition: (typeof DEFINITIONS)[number]
): boolean {
  return (
    column.type === definition.type &&
    column.length === definition.length &&
    column.isNullable &&
    !column.isPrimary &&
    !column.isGenerated &&
    !column.unsigned &&
    !column.zerofill &&
    (column.default == null || column.default === 'NULL')
  );
}

/** Execute only the inspected additive plan. Never recompute an unrestricted sync. */
export async function applyClaimsMediaUploadSchema(
  source: DataSource = getDataSource()
): Promise<number> {
  const runner = source.createQueryRunner('master');
  try {
    const table = await runner.getTable(MINTING_CLAIMS_TABLE);
    if (!table)
      throw new Error('Claim media schema requires an existing claims table');
    const missing = new Set<string>();
    for (const definition of DEFINITIONS) {
      const column = table.findColumnByName(definition.name);
      if (!column) missing.add(definition.name);
      else if (!compatible(column, definition))
        throw new Error('Claim media lease column is incompatible');
    }
    const allowed = new Map(
      DEFINITIONS.map((definition) => [
        `ALTER TABLE \`${MINTING_CLAIMS_TABLE}\` ADD \`${definition.name}\` ${definition.type}${definition.length ? `(${definition.length})` : ''} NULL`,
        definition.name
      ])
    );
    const plan = await source.driver.createSchemaBuilder().log();
    const additions = new Set<string>();
    for (const statement of plan.upQueries) {
      const column = allowed.get(statement.query);
      if (
        !column ||
        !missing.has(column) ||
        additions.has(column) ||
        statement.parameters?.length
      ) {
        throw new Error('Claim media schema plan contains unapproved changes');
      }
      additions.add(column);
    }
    if (additions.size !== missing.size)
      throw new Error('Claim media schema plan is incomplete');
    for (const statement of plan.upQueries) {
      // MySQL DDL commits independently. A later failure is retried by inspecting
      // the remaining missing columns, never by undoing a successful addition.
      await runner.query(statement.query);
    }
    if (plan.upQueries.length) {
      const remaining = await source.driver.createSchemaBuilder().log();
      if (remaining.upQueries.length) {
        throw new Error('Claim media schema did not reach the expected state');
      }
    }
    return additions.size;
  } finally {
    await runner.release();
  }
}
