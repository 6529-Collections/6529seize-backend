import { DbPoolName } from '@/db-query.options';
import { CustomApiCompliantException } from '@/exceptions';
import { dbSupplier, SqlExecutor } from '@/sql-executor';
import { MARKET_WETH } from '@/marketplace/seaport.registry';
import { marketUintSchema } from '@/marketplace/seaport.schema';

/** Read only tracked liabilities; external signatures and balances remain unreserved. */
export async function collectOfferExposure(
  wallet: string,
  db: SqlExecutor = dbSupplier()
): Promise<bigint> {
  const rows = await db.execute<{ liability_wei: string }>(
    'SELECT liability_wei FROM market_operations WHERE wallet=:wallet AND currency=:currency AND liability_wei<>:zero LIMIT 10001',
    { wallet: wallet.toLowerCase(), currency: MARKET_WETH, zero: '0' },
    { forcePool: DbPoolName.WRITE }
  );
  if (
    rows.length > 10000 ||
    rows.some((row) => !marketUintSchema.safeParse(row.liability_wei).success)
  )
    throw new CustomApiCompliantException(
      503,
      'Existing offer commitments could not be checked.',
      'OFFER_EXPOSURE_UNAVAILABLE'
    );
  return rows.reduce(
    (total, row) => total + BigInt(row.liability_wei),
    BigInt(0)
  );
}
