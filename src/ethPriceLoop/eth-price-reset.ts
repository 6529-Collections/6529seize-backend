import { getRedisClient } from '@/redis';
import { HISTORY_START_MS, PRICE_INTERVAL_MS } from './coinbase';
export interface PriceReset {
  next: number;
  end: number;
  latched: boolean;
}
function key(): string {
  if (!process.env.DB_NAME || !process.env.DB_HOST)
    throw new Error('ETH price reset requires database identity');
  return `eth-price:coinbase-reset:v1:${process.env.DB_HOST}:${process.env.DB_NAME}`;
}
export async function getPriceReset(
  requested: boolean,
  end: number
): Promise<PriceReset | null> {
  const redis = getRedisClient();
  if (!redis?.isReady) {
    if (requested)
      throw new Error('ETH price reset requires Redis for resumable progress');
    return null;
  }
  const raw = await redis.get(key());
  let state: PriceReset | null = raw ? JSON.parse(raw) : null;
  if (
    state &&
    (!Number.isSafeInteger(state.next) ||
      !Number.isSafeInteger(state.end) ||
      state.next % PRICE_INTERVAL_MS !== 0 ||
      state.end % PRICE_INTERVAL_MS !== 0 ||
      state.next < HISTORY_START_MS + PRICE_INTERVAL_MS ||
      state.next > state.end + PRICE_INTERVAL_MS ||
      state.end < HISTORY_START_MS + PRICE_INTERVAL_MS ||
      state.end > end ||
      typeof state.latched !== 'boolean')
  ) {
    throw new Error('Invalid ETH price reset checkpoint');
  }
  if (requested && (!state || (!state.latched && state.next > state.end))) {
    state = { next: HISTORY_START_MS + PRICE_INTERVAL_MS, end, latched: true };
  } else if (state) state.latched = requested;
  if (state) await savePriceReset(state);
  return state;
}
export async function savePriceReset(state: PriceReset): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady)
    throw new Error('Cannot checkpoint ETH price reset: Redis unavailable');
  // No expiry. If lost, setting reset=true restarts the repeatable upserts.
  await redis.set(key(), JSON.stringify(state));
}
