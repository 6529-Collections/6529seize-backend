import { getRedisClient } from '@/redis';
import { Logger } from '@/logging';
import { EthPrice } from '@/entities/IEthPrice';
import { HISTORY_START_MS, PRICE_INTERVAL_MS } from './coinbase';
import { ethPriceStateKey } from './eth-price-state-key';

export interface UnavailablePrices {
  first: number;
  last: number;
  retryAt: number;
}
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const logger = Logger.get('ETH_PRICE');
// Best-effort cooldown survives Redis disconnects in a warm Lambda as well.
const localRanges = new Map<string, UnavailablePrices[]>();

function isUnavailableRange(value: unknown): value is UnavailablePrices {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<UnavailablePrices>;
  return (
    Number.isSafeInteger(row.first) &&
    Number.isSafeInteger(row.last) &&
    Number.isSafeInteger(row.retryAt) &&
    row.first! >= HISTORY_START_MS + PRICE_INTERVAL_MS &&
    row.last! >= row.first! &&
    row.first! % PRICE_INTERVAL_MS === 0 &&
    row.last! % PRICE_INTERVAL_MS === 0
  );
}

/** Read temporary retry exclusions, never treating them as persisted coverage. */
export async function getUnavailablePrices(
  now: number
): Promise<UnavailablePrices[]> {
  const key = ethPriceStateKey('unavailable');
  let ranges = localRanges.get(key) ?? [];
  const redis = getRedisClient();
  try {
    if (redis?.isReady) {
      const raw = await redis.get(key);
      const decoded: unknown = raw === null ? [] : JSON.parse(raw);
      if (!Array.isArray(decoded) || !decoded.every(isUnavailableRange))
        throw new Error('Invalid unavailable ETH price ranges');
      ranges = decoded;
    }
  } catch (error) {
    logger.warn(
      'ETH price retry cooldown unavailable; using local retry state',
      error
    );
  }
  ranges = ranges.filter(
    (range) =>
      range.retryAt > now &&
      range.retryAt <= now + RETRY_AFTER_MS &&
      range.last <= now
  );
  localRanges.set(key, ranges);
  return ranges;
}

/** After the DB commit, defer only absent closes for a day; real prices stay authoritative. */
export async function deferMissingPrices(
  prices: EthPrice[],
  first: number,
  last: number,
  now: number
): Promise<void> {
  const found = new Set(prices.map((price) => price.timestamp_ms));
  const missing: UnavailablePrices[] = [];
  for (let close = first; close <= last; close += PRICE_INTERVAL_MS) {
    if (found.has(close)) continue;
    const previous = missing[missing.length - 1];
    if (previous?.last === close - PRICE_INTERVAL_MS) previous.last = close;
    else
      missing.push({
        first: close,
        last: close,
        retryAt: now + RETRY_AFTER_MS
      });
  }
  if (!missing.length) return;
  const key = ethPriceStateKey('unavailable');
  const ranges = [...(await getUnavailablePrices(now)), ...missing];
  localRanges.set(key, ranges);
  logger.warn(
    'Coinbase omitted ETH price candles; deferring missing closes for 24 hours',
    {
      first,
      last,
      missingCount: missing.reduce(
        (count, range) =>
          count + (range.last - range.first) / PRICE_INTERVAL_MS + 1,
        0
      )
    }
  );
  const redis = getRedisClient();
  try {
    if (redis?.isReady)
      await redis.set(key, JSON.stringify(ranges), { PX: RETRY_AFTER_MS });
  } catch (error) {
    logger.warn(
      'Could not persist ETH price retry cooldown; gaps remain discoverable',
      error
    );
  }
}
