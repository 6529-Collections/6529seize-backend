import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';
import { HISTORY_CHUNK_MS, PRICE_INTERVAL_MS } from './coinbase';
import { ethPriceStateKey } from './eth-price-state-key';

// The provider permits a day, but database repair starts conservatively.
export const MAX_REPAIR_CHUNK_MS = 60 * 60 * 1000;
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
    logger.warn('Could not persist ETH price repair window', error);
  }
}

/** Remember smaller repair windows across cold starts, without changing coverage. */
export async function getHistoryChunkMs(): Promise<number> {
  const key = ethPriceStateKey('batch-size');
  let size = localSizes.get(key) ?? MAX_REPAIR_CHUNK_MS;
  if (pendingPersistence.has(key)) {
    await persistSize(key, size);
    return size;
  }
  try {
    const redis = getRedisClient();
    if (redis?.isReady) {
      const raw = await redis.get(key);
      const saved = raw === null ? MAX_REPAIR_CHUNK_MS : Number(raw);
      if (
        !Number.isSafeInteger(saved) ||
        saved < PRICE_INTERVAL_MS ||
        saved > HISTORY_CHUNK_MS ||
        saved % PRICE_INTERVAL_MS !== 0
      )
        throw new Error('Invalid ETH price repair batch size');
      size = Math.min(saved, MAX_REPAIR_CHUNK_MS);
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
    localSizes.get(key) ?? MAX_REPAIR_CHUNK_MS,
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

/** Gradually recover a learned small limit after sustained fast, full batches. */
export async function growHistoryChunk(current: number): Promise<number> {
  const size = Math.min(current * 2, MAX_REPAIR_CHUNK_MS);
  if (size === current) return current;
  const key = ethPriceStateKey('batch-size');
  localSizes.set(key, size);
  pendingPersistence.add(key);
  await persistSize(key, size);
  logger.info(
    'Increasing ETH price repair window after fast successful batches',
    {
      previousChunkMs: current,
      nextChunkMs: size
    }
  );
  return size;
}
