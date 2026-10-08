import { createClient } from 'redis';
import { numbers } from '@/numbers';

const DELETE_CONCURRENCY = 20;
const DEADLINE_MS = 1500;

export interface SubscriptionCacheEvictionResult {
  scanned: number;
  deleted: number;
  elapsed_ms: number;
}

export function isSubscriptionCacheKey(
  key: string,
  prefix: string,
  consolidationKeys: ReadonlySet<string>
): boolean {
  if (!key.startsWith(prefix)) return false;
  const path = key.slice(prefix.length).split('?')[0];
  if (path === '/api/subscriptions/upcoming-memes-counts') return true;
  if (/^\/api\/subscriptions\/memes\/[^/]+\/count$/.test(path)) return true;
  const match =
    /^\/api\/subscriptions\/consolidation\/(?:details|upcoming-memes)(?:\/[^/]+)?\/([^/]+)$/.exec(
      path
    );
  return !!match && consolidationKeys.has(match[1]);
}

/** Own the connection so the deadline cancels commands without closing shared Redis. */
export async function evictSubscriptionCacheBatch(
  consolidationKeys: readonly string[]
): Promise<SubscriptionCacheEvictionResult> {
  const started = Date.now();
  const result = { scanned: 0, deleted: 0, elapsed_ms: 0 };
  if (!process.env.REDIS_URL || process.env.FORCE_AVOID_REDIS === 'true')
    return result;
  const port = numbers.parseIntOrNull(process.env.REDIS_PORT) ?? 6379;
  if (port < 0 || port > 65535) throw new Error('Invalid REDIS_PORT');
  const client = createClient({
    socket: {
      host: process.env.REDIS_URL,
      port,
      tls: process.env.REDIS_TLS === 'true',
      reconnectStrategy: false,
      connectTimeout: DEADLINE_MS
    },
    password: process.env.REDIS_PASSWORD,
    disableOfflineQueue: true
  });
  // node-redis requires an error listener; the failed command is reported once by the caller.
  client.on('error', () => {});
  let expired = false;
  const timeoutError = new Error('Subscription cache eviction exceeded 1500ms');
  timeoutError.name = 'TimeoutError';
  const close = () => {
    if (client.isOpen) void client.disconnect().catch(() => {});
  };
  const deadline = setTimeout(() => {
    expired = true;
    close();
  }, DEADLINE_MS);
  const checkDeadline = () => {
    if (expired || Date.now() - started >= DEADLINE_MS) throw timeoutError;
  };
  try {
    await client.connect();
    const affected = new Set(consolidationKeys);
    const prefix = `__SEIZE_CACHE_${process.env.NODE_ENV}__`;
    let cursor = 0;
    do {
      checkDeadline();
      const page = await client.scan(cursor, {
        MATCH: `${prefix}/api/subscriptions/*`,
        COUNT: 1000
      });
      cursor = page.cursor;
      result.scanned += page.keys.length;
      const keys = page.keys.filter((key) =>
        isSubscriptionCacheKey(key, prefix, affected)
      );
      for (let start = 0; start < keys.length; start += DELETE_CONCURRENCY) {
        checkDeadline();
        // Single-key DEL remains safe when keys occupy different cluster slots.
        const deleted = await Promise.all(
          keys
            .slice(start, start + DELETE_CONCURRENCY)
            .map((key) => client.del(key))
        );
        result.deleted += deleted.reduce((sum, count) => sum + count, 0);
      }
    } while (cursor !== 0);
    checkDeadline();
    return { ...result, elapsed_ms: Date.now() - started };
  } catch (error) {
    throw expired ? timeoutError : error;
  } finally {
    clearTimeout(deadline);
    close();
  }
}
