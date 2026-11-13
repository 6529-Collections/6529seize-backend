import { randomUUID } from 'node:crypto';
import { getRedisClient } from '@/redis';
import { Time } from '@/time';

/**
 * Version keys for the wave read caches. A cache entry's key embeds the
 * versions of everything it was computed from; a write moves a version and
 * so retires every entry built on the old one.
 *
 * Versions are "<epoch ms>.<random>": a new random value per change, stamped
 * with the time it was set, so a reader can tell a change too recent to have
 * replicated. A missing key reads as {@link NO_CACHE_VERSION}.
 */
export const NO_CACHE_VERSION = '0';

/**
 * An entry is not stored while a version it is keyed on changed less than
 * this long ago. Versions move after the write commits, and entries are
 * computed on a read replica: until the write has replicated, a fresh
 * computation can still miss it and would otherwise be stored under the new
 * version for the entry's whole TTL. Requests in this window read the
 * database.
 */
export const CACHE_VERSION_SETTLE_MS = 5_000;

export function newCacheVersion(): string {
  return `${Date.now()}.${randomUUID().slice(0, 8)}`;
}

/** Missing or unparseable versions count as set long ago. */
function cacheVersionTime(version: string): number {
  const time = Number(version.split('.')[0]);
  return Number.isFinite(time) ? time : 0;
}

export function areCacheVersionsSettled(
  versions: string[],
  now = Date.now()
): boolean {
  const settledBefore = now - CACHE_VERSION_SETTLE_MS;
  return versions.every(
    (version) => cacheVersionTime(version) <= settledBefore
  );
}

/**
 * Reads version keys with single-key GETs sent together (node-redis
 * pipelines them). Never MGET: these keys hash to different Redis Cluster
 * slots, and the cluster-mode cache rejects that with CROSSSLOT. Throws when
 * Redis fails, so callers treat every entry as uncached instead of guessing a
 * version; returns null when Redis is not configured.
 */
export async function readCacheVersions(
  keys: string[]
): Promise<string[] | null> {
  const redis = getRedisClient();
  if (!redis) {
    return null;
  }
  const values = await Promise.all(keys.map((key) => redis.get(key)));
  return values.map((value) => value ?? NO_CACHE_VERSION);
}

/** Single-key SET with a TTL that outlives every entry keyed on it. */
export async function bumpCacheVersion(key: string, ttl: Time): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    return;
  }
  await redis.set(key, newCacheVersion(), { EX: ttl.toSeconds() });
}
