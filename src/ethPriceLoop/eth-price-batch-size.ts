import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';
import { HISTORY_CHUNK_MS, PRICE_INTERVAL_MS } from './coinbase';
import { ethPriceStateKey } from './eth-price-state-key';

const logger = Logger.get('ETH_PRICE');
const localSizes = new Map<string, number>();
const pendingPersistence = new Set<string>();

async function persistSize(key: string, size: number): Promise<void> {
  try {
    const redis = getRedisClient();
    if (redis?.isReady) {
      await redis.set(key, String(size));
      pendingPersistence.delete(key);
    }
  } catch (error) {
    logger.warn('Could not persist smaller ETH price repair window', error);
  }
}

/** Remember smaller repair windows across cold starts, without changing coverage. */
export async function getHistoryChunkMs(): Promise<number> {
  const key = ethPriceStateKey('batch-size');
  let size = localSizes.get(key) ?? HISTORY_CHUNK_MS;
  if (pendingPersistence.has(key)) {
    await persistSize(key, size);
    return size;
  }
  try {
    const redis = getRedisClient();
    if (redis?.isReady) {
      const raw = await redis.get(key);
      const saved = raw === null ? HISTORY_CHUNK_MS : Number(raw);
      if (
        !Number.isSafeInteger(saved) ||
        saved < PRICE_INTERVAL_MS ||
        saved > HISTORY_CHUNK_MS ||
        saved % PRICE_INTERVAL_MS !== 0
      )
        throw new Error('Invalid ETH price repair batch size');
      size = saved;
    }
  } catch (error) {
    logger.warn('Using local ETH price repair batch size', error);
  }
  localSizes.set(key, size);
  return size;
}

/** A work deadline reduces the next attempt; never replay a failed transaction here. */
export async function shrinkHistoryChunk(
  error: unknown,
  first: number,
  last: number
): Promise<number | undefined> {
  if (
    !(error instanceof SqlExecutionBudgetExceededError) ||
    error.code !== 'SQL_BUDGET_EXCEEDED' ||
    error.phase !== 'WORK' ||
    error.commitOutcome !== 'NOT_SENT' ||
    first >= last
  )
    return;
  const key = ethPriceStateKey('batch-size');
  const intervals = (last - first) / PRICE_INTERVAL_MS + 1;
  const size = Math.min(
    localSizes.get(key) ?? HISTORY_CHUNK_MS,
    Math.max(1, Math.floor(intervals / 2)) * PRICE_INTERVAL_MS
  );
  localSizes.set(key, size);
  pendingPersistence.add(key);
  logger.warn('Reducing ETH price repair window after database work timeout', {
    first,
    last,
    nextChunkMs: size
  });
  await persistSize(key, size);
  return size;
}
