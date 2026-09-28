import axios from 'axios';
import axiosRetry from 'axios-retry';
import { EthPrice } from '@/entities/IEthPrice';

export const PRICE_INTERVAL_MS = 300_000;
export const DAILY_PRICE_INTERVAL_MS = 86_400_000;
export const FIVE_MINUTE_HISTORY_START_MS = Date.UTC(2026, 0, 1);
export const HISTORY_START_MS = Date.UTC(2021, 9, 1);
export const HISTORY_CHUNK_MS = 24 * 60 * 60 * 1000;
export const PRICE_TOLERANCE_MS = 90_000;
const client = axios.create({
  baseURL: 'https://api.exchange.coinbase.com/products/ETH-USD',
  timeout: 10_000
});
axiosRetry(client, {
  retries: 3,
  // Each attempt has its own timeout, with a bounded backoff between attempts.
  shouldResetTimeout: true,
  retryDelay: (attempt) => Math.min(1000 * 2 ** (attempt - 1), 8000),
  retryCondition: (error) =>
    axiosRetry.isNetworkError(error) ||
    error.code === 'ECONNABORTED' ||
    error.response?.status === 429 ||
    (error.response?.status ?? 0) >= 500
});

function priceSample(timestamp: number, price: unknown): EthPrice {
  const usd =
    typeof price === 'number' || typeof price === 'string'
      ? Number(price)
      : Number.NaN;
  if (!Number.isSafeInteger(timestamp) || !Number.isFinite(usd) || usd <= 0) {
    throw new Error('Invalid Coinbase ETH/USD price sample');
  }
  return { timestamp_ms: timestamp, date: new Date(timestamp), usd_price: usd };
}

export async function fetchLivePrice(now?: number): Promise<EthPrice> {
  const { data } = await client.get<unknown>('/ticker');
  if (
    !data ||
    typeof data !== 'object' ||
    !('time' in data) ||
    !('price' in data)
  ) {
    throw new Error('Invalid Coinbase ticker response');
  }
  const timestamp =
    typeof data.time === 'string' ? Date.parse(data.time) : Number.NaN;
  const sample = priceSample(timestamp, data.price);
  const currentTime = now ?? Date.now();
  if (
    timestamp > currentTime + 30_000 ||
    currentTime - timestamp > PRICE_INTERVAL_MS
  ) {
    throw new Error('Coinbase ticker is stale or future-dated');
  }
  return sample;
}

/** Return actual candles at inclusive close boundaries, allowing absent ticks. */
export async function fetchHistoricPrices(
  firstClose: number,
  lastClose: number,
  now = Date.now(),
  intervalMs: number = PRICE_INTERVAL_MS
): Promise<EthPrice[]> {
  if (
    ![PRICE_INTERVAL_MS, DAILY_PRICE_INTERVAL_MS].includes(intervalMs) ||
    firstClose % intervalMs !== 0 ||
    lastClose % intervalMs !== 0 ||
    firstClose > lastClose ||
    lastClose > now ||
    (lastClose - firstClose) / intervalMs >= 300
  )
    throw new Error('Invalid Coinbase candle range');
  const { data } = await client.get<unknown>('/candles', {
    params: {
      granularity: intervalMs / 1000,
      start: new Date(firstClose - intervalMs).toISOString(),
      end: new Date(lastClose - intervalMs).toISOString()
    }
  });
  if (!Array.isArray(data)) throw new Error('Invalid Coinbase candle response');
  const prices = new Map<number, EthPrice>();
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 6 || typeof row[0] !== 'number') {
      throw new Error('Invalid Coinbase candle');
    }
    const close = row[0] * 1000 + intervalMs;
    // Coinbase may return buckets preceding start or beyond the requested end.
    if (close < firstClose || close > lastClose) continue;
    if (close % intervalMs !== 0 || prices.has(close)) {
      throw new Error('Duplicate or misaligned Coinbase candle');
    }
    prices.set(close, priceSample(close, row[4]));
  }
  // Coinbase omits intervals with no ticks. Keep real samples; the caller
  // defers missing closes for later retry without inventing prices.
  return Array.from(prices.values()).sort(
    (a, b) => a.timestamp_ms - b.timestamp_ms
  );
}
