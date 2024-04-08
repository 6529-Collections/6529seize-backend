import { ETH_PRICE_TABLE } from '../constants';
import { getDataSource } from '../db';
import { EthPrice } from '../entities/IEthPrice';

export async function getEthPriceCount() {
  return await getDataSource().getRepository(EthPrice).count();
}

export async function persistEthPrices(prices: EthPrice[]) {
  await getDataSource()
    .getRepository(EthPrice)
    .upsert(prices, ['timestamp_ms']);
}

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
