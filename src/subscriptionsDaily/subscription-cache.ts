import { randomUUID } from 'node:crypto';
import { numbers } from '@/numbers';
import { Time } from '@/time';
import { Logger } from '@/logging';
import { sqlExecutor } from '@/sql-executor';
import { DbPoolName } from '@/db-query.options';
import { SUBSCRIPTION_CACHE_INVALIDATIONS_TABLE } from '@/constants';
import { redisFailureCategory } from '@/redis-recovery';
import {
  evictSubscriptionCacheBatch,
  SubscriptionCacheEvictionError,
  SubscriptionCacheEvictionResult
} from './subscription-cache-eviction';

const logger = Logger.get('SUBSCRIPTION_CACHE');
const RETRY_DELAY_MS = 60_000;
const KEYS_PER_REQUEST = 500;
const ESCALATE_AFTER_ATTEMPTS = 3;
const writePool = { forcePool: DbPoolName.WRITE };

interface InvalidationRequest {
  id: string;
  consolidation_keys: string[] | string;
  attempts: number;
  scan_cursor?: string;
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
      `SELECT id, consolidation_keys, attempts, scan_cursor FROM ${SUBSCRIPTION_CACHE_INVALIDATIONS_TABLE}
       WHERE parked = 0 AND next_attempt_at <= :now ORDER BY next_attempt_at, id LIMIT 20`,
      { now: Date.now() },
      writePool
    );
    const groups = new Map<string, InvalidationRequest[]>();
    for (const request of requests) {
      const groupKey = `${request.attempts}:${request.scan_cursor ?? '0'}`;
      const group = groups.get(groupKey) ?? [];
      group.push(request);
      groups.set(groupKey, group);
    }
    // Different cursors/history cannot share a pass. Bound parallel owned connections to one.
    for (const group of Array.from(groups.values()))
      await attemptEviction(group, true);
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
  const valid: InvalidationRequest[] = [];
  const keys: string[] = [];
  for (const request of requests) {
    try {
      keys.push(...parseKeys(request.consolidation_keys));
      valid.push(request);
    } catch (error) {
      await parkRequest(request.id, error, durable);
    }
  }
  if (!valid.length) return;
  const ids = valid.map((request) => request.id);
  const attempt = valid[0].attempts + 1;
  const cursor = valid[0].scan_cursor ?? '0';
  let result: SubscriptionCacheEvictionResult;
  try {
    // Allow the read replica to catch up before responses can refill Redis.
    await Time.millis(
      numbers.parseIntOrNull(process.env.REPLICA_CATCHUP_DELAY_AFTER_WRITE) ??
        500
    ).sleep();
    result = await evictSubscriptionCacheBatch(keys, cursor);
  } catch (error) {
    const failure =
      error instanceof SubscriptionCacheEvictionError ? error.failure : error;
    const resumeCursor =
      error instanceof SubscriptionCacheEvictionError ? error.cursor : cursor;
    await recordFailure(ids, attempt, started, failure, durable, resumeCursor);
    return;
  }
  await finishEviction(ids, keys.length, result, durable);
}

/** DB checkpoint/acknowledgement failures retain requests without aging Redis retry history. */
async function finishEviction(
  ids: string[],
  keyCount: number,
  result: SubscriptionCacheEvictionResult,
  durable: boolean
): Promise<void> {
  try {
    if (!result.complete) {
      if (durable) await saveProgress(ids, result.cursor);
      logger.info('Subscription cache scan reached a continuation checkpoint', {
        ...result,
        retry_recorded: durable
      });
      return;
    }
    if (durable)
      await sqlExecutor.execute(
        `DELETE FROM ${SUBSCRIPTION_CACHE_INVALIDATIONS_TABLE} WHERE id IN (:ids)`,
        { ids },
        writePool
      );
    logger.info('Subscription cache invalidation batch completed', {
      requests: ids.length,
      consolidation_keys: keyCount,
      ...result
    });
  } catch (error) {
    logger.errorWithDiagnostic(
      {
        operation: 'SUBSCRIPTION_CACHE_BOOKKEEPING',
        category: 'UNKNOWN',
        recovery: { state: 'unknown' }
      },
      'Could not persist subscription cache scan progress or acknowledgement; requests remain eligible for replay',
      {
        requests: ids.length,
        completed_cursor: result.cursor,
        error: describeError(error)
      }
    );
  }
}

async function recordFailure(
  ids: string[],
  attempt: number,
  started: number,
  error: unknown,
  durable: boolean,
  cursor: string
): Promise<void> {
  const nextAttempt = Date.now() + RETRY_DELAY_MS;
  const description = describeError(error);
  let retryRecorded = durable;
  if (durable) {
    try {
      await sqlExecutor.execute(
        `UPDATE ${SUBSCRIPTION_CACHE_INVALIDATIONS_TABLE}
         SET attempts = attempts + 1, next_attempt_at = :nextAttempt, last_error = :description, scan_cursor = :cursor
         WHERE id IN (:ids)`,
        { ids, nextAttempt, description, cursor },
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

/** Reject corrupt rows independently so healthy requests can continue. */
function parseKeys(value: string[] | string): string[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    parsed.some((key) => typeof key !== 'string' || !key.length)
  )
    throw new Error('Invalid subscription cache request keys');
  return parsed as string[];
}

/** Park invalid data for operator repair rather than consuming every retry window. */
async function parkRequest(
  id: string,
  error: unknown,
  durable: boolean
): Promise<void> {
  try {
    if (durable)
      await sqlExecutor.execute(
        `UPDATE ${SUBSCRIPTION_CACHE_INVALIDATIONS_TABLE} SET parked = 1, last_error = :description WHERE id = :id`,
        { id, description: describeError(error) },
        writePool
      );
  } catch (parkError) {
    logger.error(
      'Could not park malformed subscription cache request; continuing healthy requests',
      { id, error: describeError(parkError) }
    );
    return;
  }
  logger.errorWithDiagnostic(
    {
      operation: 'SUBSCRIPTION_CACHE_REQUEST_INVALID',
      category: 'VALIDATION',
      recovery: { state: 'terminal' }
    },
    'Malformed subscription cache request parked for investigation',
    { id, error: describeError(error) }
  );
}

/** Checkpoint only fully deleted pages; do not count healthy continuation as a failure. */
async function saveProgress(ids: string[], cursor: string): Promise<void> {
  await sqlExecutor.execute(
    `UPDATE ${SUBSCRIPTION_CACHE_INVALIDATIONS_TABLE}
     SET scan_cursor = :cursor, next_attempt_at = :nextAttempt, last_error = NULL WHERE id IN (:ids)`,
    { ids, cursor, nextAttempt: Date.now() },
    writePool
  );
}

/** Serialize useful error text without Object's default stringification. */
function describeError(error: unknown): string {
  if (error instanceof Error)
    return `${error.name}: ${error.message}`.slice(0, 2000);
  if (typeof error === 'string') return error.slice(0, 2000);
  try {
    return (JSON.stringify(error) ?? 'Unknown failure').slice(0, 2000);
  } catch {
    return 'Unserializable failure';
  }
}
