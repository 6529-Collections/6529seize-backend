import type { DataSource, TableColumn } from 'typeorm';
import { getDataSource } from '@/db';
import { NFT_LINKS_TABLE } from '@/constants';

const COLUMN = 'refresh_retry_state';
const ADD = `ALTER TABLE \`${NFT_LINKS_TABLE}\` ADD \`${COLUMN}\` json NULL`;

function compatible(column: TableColumn): boolean {
  return (
    column.type === 'json' &&
    column.length === '' &&
    column.isNullable &&
    !column.isPrimary &&
    !column.isGenerated &&
    !column.unsigned &&
    !column.zerofill &&
    (column.default == null || column.default === 'NULL')
  );
}

/** Inspect and execute only this additive statement, never unrestricted sync. */
export async function applyNftLinkPageRetrySchema(
  source: DataSource = getDataSource()
): Promise<number> {
  const runner = source.createQueryRunner('master');
  try {
    const table = await runner.getTable(NFT_LINKS_TABLE);
    if (!table)
      throw new Error('NFT retry schema requires an existing nft_links table');
    const column = table.findColumnByName(COLUMN);
    if (column && !compatible(column))
      throw new Error('NFT retry column is incompatible');
    const plan = await source.driver.createSchemaBuilder().log();
    if (
      plan.upQueries.length !== (column ? 0 : 1) ||
      plan.upQueries.some(
        (statement) => statement.query !== ADD || statement.parameters?.length
      )
    )
      throw new Error(
        'NFT retry schema plan contains unapproved or missing changes'
      );
    for (const statement of plan.upQueries) await runner.query(statement.query);
    if (
      plan.upQueries.length &&
      (await source.driver.createSchemaBuilder().log()).upQueries.length
    ) {
      throw new Error('NFT retry schema did not reach the expected state');
    }
    return plan.upQueries.length;
  } finally {
    await runner.release();
  }
}
