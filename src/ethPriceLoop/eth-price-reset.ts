import { Logger } from '@/logging';
import { ethPriceStateKey } from './eth-price-state-key';
import { getRedisClient } from '@/redis';
import { HISTORY_START_MS, PRICE_INTERVAL_MS } from './coinbase';
export interface PriceReset {
  next: number;
  end: number;
  latched: boolean;
}
const logger = Logger.get('ETH_PRICE');

/** Validate a checkpoint completely before it can advance historical work. */
function parseReset(raw: string | null, end: number): PriceReset | null {
  if (raw === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('Invalid ETH price reset checkpoint');
  }
  if (!decoded || typeof decoded !== 'object')
    throw new Error('Invalid ETH price reset checkpoint');
  const state = decoded as PriceReset;
  if (
    !Number.isSafeInteger(state.next) ||
    !Number.isSafeInteger(state.end) ||
    state.next % PRICE_INTERVAL_MS !== 0 ||
    state.end % PRICE_INTERVAL_MS !== 0 ||
    state.next < HISTORY_START_MS ||
    state.next > state.end + PRICE_INTERVAL_MS ||
    state.end < HISTORY_START_MS ||
    state.end > end ||
    typeof state.latched !== 'boolean'
  )
    throw new Error('Invalid ETH price reset checkpoint');
  return state;
}

/** Load/rearm a non-destructive reset; clearing the flag does not abort it. */
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
  const raw = await redis.get(ethPriceStateKey('reset'));
  let state = parseReset(raw, end);
  if (requested && (!state || (!state.latched && state.next > state.end))) {
    state = { next: HISTORY_START_MS, end, latched: true };
    logger.info(
      `[ETH PRICE RESET ARMED] [NEXT ${state.next}] [END ${state.end}]`
    );
  } else if (state) state.latched = requested;
  if (state) await savePriceReset(state);
  return state;
}
/** Checkpoint only after the matching database repair commits. */
export async function savePriceReset(state: PriceReset): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady)
    throw new Error('Cannot checkpoint ETH price reset: Redis unavailable');
  // No expiry. If lost, setting reset=true restarts the repeatable upserts.
  await redis.set(ethPriceStateKey('reset'), JSON.stringify(state));
}
