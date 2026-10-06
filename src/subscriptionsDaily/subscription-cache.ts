import { numbers } from '@/numbers';
import { Time } from '@/time';
import { Logger } from '@/logging';
import { evictRedisCacheForPathWithTimeout } from '@/redis';

const logger = Logger.get('SUBSCRIPTION_CACHE');

/** Call only after the quantity transaction has committed. */
export async function invalidateUpcomingSubscriptionCaches(
  consolidationKeys: readonly string[]
): Promise<void> {
  if (consolidationKeys.length === 0) {
    return;
  }
  const paths = [
    '/api/subscriptions/upcoming-memes-counts',
    '/api/subscriptions/memes/*/count'
  ];
  for (const key of Array.from(new Set(consolidationKeys))) {
    paths.push(
      `/api/subscriptions/consolidation/details/${key}`,
      `/api/subscriptions/consolidation/upcoming-memes/${key}`,
      `/api/subscriptions/consolidation/upcoming-memes/*/${key}`
    );
  }
  // Evict after the usual replica grace period, rather than allowing an
  // immediate read of the replica to refill the cache with the previous count.
  await Time.millis(
    numbers.parseIntOrNull(process.env.REPLICA_CATCHUP_DELAY_AFTER_WRITE) ?? 500
  ).sleep();
  for (let start = 0; start < paths.length; start += 20) {
    await Promise.allSettled(paths.slice(start, start + 20).map(evictPath));
  }
}

async function evictPath(path: string): Promise<void> {
  const result = await evictRedisCacheForPathWithTimeout({
    path,
    singleKeyDeletes: true
  });
  if (!result.success) {
    logger.warn('Failed to invalidate subscription cache', {
      path,
      error: result.error
    });
  }
}
