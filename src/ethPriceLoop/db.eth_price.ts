import { ETH_PRICE_TABLE } from '@/constants';
import { getDataSource } from '../db';
export async function getClosestEthUsdPrice(date: Date): Promise<number> {
  const timestampMs = date.getTime();
  const price = await getDataSource().manager.query(
    `
      SELECT * from ${ETH_PRICE_TABLE}
      WHERE timestamp_ms <= ?
      ORDER BY timestamp_ms DESC
      LIMIT 1
  `,
    [timestampMs]
  );

  return price[0]?.usd_price ?? 0;
}
