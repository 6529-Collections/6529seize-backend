import {
  TDH_BLOCKS_TABLE,
  TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE
} from '@/constants';
import { ConnectionWrapper, dbSupplier } from '@/sql-executor';

/**
 * Named inputs recorded with an entry, so a check can recompute its result:
 * the TDH snapshot a phase read, and the minted-count cursor a normalize
 * reset (minted counts restart after that block).
 */

async function maxOf(
  sql: string,
  connection: ConnectionWrapper<any>
): Promise<number | null> {
  const row = await dbSupplier().oneOrNull<{ value: number | string | null }>(
    sql,
    undefined,
    { wrappedConnection: connection }
  );
  return row?.value === null || row?.value === undefined
    ? null
    : Number(row.value);
}

export async function latestTdhBlock(
  connection: ConnectionWrapper<any>
): Promise<number | null> {
  return maxOf(
    `select max(block_number) as value from ${TDH_BLOCKS_TABLE}`,
    connection
  );
}

export async function distributionCursorBlock(
  connection: ConnectionWrapper<any>
): Promise<number | null> {
  return maxOf(
    `select max(block) as value from ${TRANSACTIONS_PROCESSED_DISTRIBUTION_BLOCKS_TABLE}`,
    connection
  );
}
