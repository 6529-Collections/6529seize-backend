import { randomUUID } from 'node:crypto';
import { numbers } from '@/numbers';
import { Time } from '@/time';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import { DbPoolName } from '@/db-query.options';
import { SUBSCRIPTION_CACHE_INVALIDATIONS_TABLE } from '@/constants';
import { redisFailureCategory } from '@/redis-recovery';
import { evictSubscriptionCacheBatch } from './subscription-cache-eviction';

const logger = Logger.get('SUBSCRIPTION_CACHE');
const RETRY_DELAY_MS = 60_000;
const KEYS_PER_REQUEST = 500;
const ESCALATE_AFTER_ATTEMPTS = 3;
const writePool = { forcePool: DbPoolName.WRITE };

interface InvalidationRequest {
  id: string;
  consolidation_keys: string[] | string;
  attempts: number;
}

/** Call only after the quantity transaction has committed. */
export async function invalidateUpcomingSubscriptionCaches(
  consolidationKeys: readonly string[]
): Promise<void> {
  const keys = Array.from(new Set(consolidationKeys));
  if (keys.length === 0) return;
  const now = Date.now();
  const requests: InvalidationRequest[] = [];
  for (let start = 0; start < keys.length; start += KEYS_PER_REQUEST) {
    requests.push({
      id: randomUUID(),
      consolidation_keys: keys.slice(start, start + KEYS_PER_REQUEST),
      attempts: 0
    });
  }
  try {
    // Persist before attempting Redis, so process termination also leaves retry work.
    await sqlExecutor.bulkInsert(
      SUBSCRIPTION_CACHE_INVALIDATIONS_TABLE,
      requests.map((request) => ({
        ...request,
        consolidation_keys: JSON.stringify(request.consolidation_keys),
        created_at: now,
        next_attempt_at: now + RETRY_DELAY_MS,
        last_error: null
      })),
      [
        'id',
        'consolidation_keys',
        'created_at',
        'next_attempt_at',
        'attempts',
        'last_error'
      ],
      undefined,
      { chunkSize: 20 }
    );
  } catch (error) {
    // Committed balances must not be reported as failed because cache bookkeeping failed.
    logger.error(
      'Could not persist subscription cache invalidation retry work',
      error
    );
    await attemptEviction(requests, false);
    return;
  }
  await attemptEviction(requests, true);
}

/** Runs even when the balance delta is empty; read the primary to avoid replica lag. */
export async function retryPendingSubscriptionCacheInvalidations(): Promise<void> {
  try {
    const requests = await sqlExecutor.execute<InvalidationRequest>(
      `SELECT id, consolidation_keys, attempts FROM ${SUBSCRIPTION_CACHE_INVALIDATIONS_TABLE}
       WHERE next_attempt_at <= :now ORDER BY next_attempt_at, id LIMIT 20`,
      { now: Date.now() },
      writePool
    );
    if (requests.length) await attemptEviction(requests, true);
  } catch (error) {
    logger.error(
      'Could not read subscription cache invalidation retry work',
      error
    );
  }
}

async function attemptEviction(
  requests: InvalidationRequest[],
  durable: boolean
): Promise<void> {
  const started = Date.now();
  const ids = requests.map((request) => request.id);
  const attempt = Math.max(...requests.map((request) => request.attempts)) + 1;
  try {
    const keys = requests.flatMap((request) =>
      typeof request.consolidation_keys === 'string'
        ? (JSON.parse(request.consolidation_keys) as string[])
        : request.consolidation_keys
    );
    // Allow the read replica to catch up before responses can refill Redis.
    await Time.millis(
      numbers.parseIntOrNull(process.env.REPLICA_CATCHUP_DELAY_AFTER_WRITE) ??
        500
    ).sleep();
    const result = await evictSubscriptionCacheBatch(keys);
    if (durable)
      await sqlExecutor.execute(
        `DELETE FROM ${SUBSCRIPTION_CACHE_INVALIDATIONS_TABLE} WHERE id IN (:ids)`,
        { ids },
        writePool
      );
    logger.info('Subscription cache invalidation batch completed', {
      requests: ids.length,
      consolidation_keys: keys.length,
      ...result
    });
  } catch (error) {
    await recordFailure(ids, attempt, started, error, durable);
  }
}

async function recordFailure(
  ids: string[],
  attempt: number,
  started: number,
  error: unknown,
  durable: boolean
): Promise<void> {
  const nextAttempt = Date.now() + RETRY_DELAY_MS;
  const description =
    error instanceof Error
      ? `${error.name}: ${error.message}`.slice(0, 2000)
      : String(error).slice(0, 2000);
  let retryRecorded = durable;
  if (durable) {
    try {
      await sqlExecutor.execute(
        `UPDATE ${SUBSCRIPTION_CACHE_INVALIDATIONS_TABLE}
         SET attempts = attempts + 1, next_attempt_at = :nextAttempt, last_error = :description
         WHERE id IN (:ids)`,
        { ids, nextAttempt, description },
        writePool
      );
    } catch (recordError) {
      retryRecorded = false;
      logger.error(
        'Could not update subscription cache retry state',
        recordError
      );
    }
  }
  // Persistent failures remain retryable but require investigation after two amber attempts.
  const category = redisFailureCategory(error);
  const pending =
    retryRecorded &&
    category !== 'UNKNOWN' &&
    attempt < ESCALATE_AFTER_ATTEMPTS;
  logger.errorWithDiagnostic(
    {
      operation: 'SUBSCRIPTION_CACHE_INVALIDATION',
      category,
      recovery: {
        state: pending ? 'pending' : 'unknown',
        attempt,
        maxAttempts: ESCALATE_AFTER_ATTEMPTS,
        ...(pending
          ? { nextAttemptAt: new Date(nextAttempt).toISOString() }
          : { nextEligibleAt: new Date(nextAttempt).toISOString() })
      }
    },
    'Subscription cache invalidation batch failed',
    {
      requests: ids.length,
      elapsed_ms: Date.now() - started,
      error: description,
      retry_recorded: retryRecorded
    }
  );
}
