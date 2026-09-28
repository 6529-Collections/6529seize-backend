import { ETH_PRICE_TABLE } from '@/constants';
import { BaseTransaction } from '@/entities/ITransaction';

export type PriceQuery = (
  sql: string,
  parameters: unknown[]
) => Promise<{ usd_price: number | string }[]>;

/**
 * Must run inside the transaction that persists the row, at REPEATABLE READ.
 * The locking range read sees committed corrections even after an earlier
 * snapshot, and blocks history inserts into that range until the writer commits.
 */
export async function refreshTransactionUsdAtWrite(
  transaction: BaseTransaction,
  query: PriceQuery
): Promise<void> {
  const timestamp =
    Math.floor(new Date(transaction.transaction_date).getTime() / 1000) * 1000;
  const rows = await query(
    `SELECT usd_price FROM ${ETH_PRICE_TABLE}
     WHERE timestamp_ms <= ? ORDER BY timestamp_ms DESC LIMIT 1 FOR SHARE`,
    [timestamp]
  );
  const price = Number(rows[0]?.usd_price ?? 0);
  transaction.eth_price_usd = price;
  transaction.value_usd = transaction.value * price;
  transaction.gas_usd = transaction.gas * price;
}
