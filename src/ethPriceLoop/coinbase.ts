import axios from 'axios';
import axiosRetry from 'axios-retry';
import { EthPrice } from '@/entities/IEthPrice';

export const PRICE_INTERVAL_MS = 300_000;
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
      : NaN;
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
  const timestamp = typeof data.time === 'string' ? Date.parse(data.time) : NaN;
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

/** Inclusive candle-close boundaries. No unfinished candle is accepted. */
export async function fetchHistoricPrices(
  firstClose: number,
  lastClose: number,
  now = Date.now()
): Promise<EthPrice[]> {
  if (
    firstClose % PRICE_INTERVAL_MS !== 0 ||
    lastClose % PRICE_INTERVAL_MS !== 0 ||
    firstClose > lastClose ||
    lastClose > now ||
    (lastClose - firstClose) / PRICE_INTERVAL_MS >= 300
  )
    throw new Error('Invalid Coinbase candle range');
  const { data } = await client.get<unknown>('/candles', {
    params: {
      granularity: PRICE_INTERVAL_MS / 1000,
      start: new Date(firstClose - PRICE_INTERVAL_MS).toISOString(),
      end: new Date(lastClose - PRICE_INTERVAL_MS).toISOString()
    }
  });
  if (!Array.isArray(data)) throw new Error('Invalid Coinbase candle response');
  const prices = new Map<number, EthPrice>();
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 6 || typeof row[0] !== 'number') {
      throw new Error('Invalid Coinbase candle');
    }
    const close = row[0] * 1000 + PRICE_INTERVAL_MS;
    // Coinbase may return buckets preceding start or beyond the requested end.
    if (close < firstClose || close > lastClose) continue;
    if (close % PRICE_INTERVAL_MS !== 0 || prices.has(close)) {
      throw new Error('Duplicate or misaligned Coinbase candle');
    }
    prices.set(close, priceSample(close, row[4]));
  }
  const expected = (lastClose - firstClose) / PRICE_INTERVAL_MS + 1;
  if (prices.size !== expected) {
    throw new Error(
      `Incomplete Coinbase history: expected ${expected}, received ${prices.size}`
    );
  }
  return Array.from(prices.values()).sort(
    (a, b) => a.timestamp_ms - b.timestamp_ms
  );
}
