import { createClient, RedisClientType as Redis } from 'redis';
import { randomUUID } from 'node:crypto';
import { Logger } from './logging';
import { numbers } from './numbers';
import { Time } from './time';
import { redisFailureCategory } from '@/redis-recovery';

let redis: Redis;
let redisReadyEvents = 0;
let redisReconnectEvents = 0;

/**
 * Opt-in behavior for processes that must keep serving while Redis is
 * unreachable (the API). Without it, the client keeps node-redis defaults:
 * commands queue until the connection is back and initRedis waits for the
 * first connection indefinitely.
 */
export interface RedisFailFastOptions {
  /** Upper bound for each cache/rate-limit helper command. */
  readonly commandTimeoutMs: number;
  /** Per-attempt socket connect timeout. */
  readonly connectTimeoutMs: number;
  /** How long initRedis waits for the first connection before continuing. */
  readonly initialConnectTimeoutMs: number;
  /** Cap for the exponential reconnect backoff. Reconnects never give up. */
  readonly maxReconnectDelayMs: number;
}

/**
 * Raised by fail-fast helpers when Redis is not connected or a command
 * outlives its budget. A timed-out command may still reach Redis later, so
 * its outcome is unknown: never treat it as a completed write or a lock held.
 */
export class RedisUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'RedisUnavailableError';
  }
}

const RECONNECT_BASE_DELAY_MS = 50;
const UNAVAILABLE_WARNING_INTERVAL_MS = 10_000;
let failFastOptions: RedisFailFastOptions | null = null;
let lastUnavailableWarningAt: number | null = null;

export function failFastReconnectDelayMs(
  retries: number,
  maxDelayMs: number
): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** retries, maxDelayMs);
}

async function runBoundedCommand<T>(
  operation: string,
  command: (client: Redis) => Promise<T>
): Promise<T> {
  const options = failFastOptions;
  if (!options) {
    return command(redis);
  }
  if (!redis.isReady) {
    throw new RedisUnavailableError(
      `Redis ${operation} skipped: client is not connected`
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new RedisUnavailableError(
          `Redis ${operation} timed out after ${options.commandTimeoutMs}ms`
        )
      );
    }, options.commandTimeoutMs);
  });
  try {
    return await Promise.race([command(redis), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Cache reads and writes treat an unavailable Redis as a miss / no-op. */
async function runFailOpenCommand<T>(
  operation: string,
  fallback: T,
  command: (client: Redis) => Promise<T>
): Promise<T> {
  try {
    return await runBoundedCommand(operation, command);
  } catch (error) {
    if (!(error instanceof RedisUnavailableError)) {
      throw error;
    }
    warnRedisUnavailable(error);
    return fallback;
  }
}

function warnRedisUnavailable(error: RedisUnavailableError) {
  const now = Date.now();
  if (
    lastUnavailableWarningAt !== null &&
    now - lastUnavailableWarningAt < UNAVAILABLE_WARNING_INTERVAL_MS
  ) {
    return;
  }
  lastUnavailableWarningAt = now;
  logger.warn(`${error.message}; continuing without Redis`);
}

export const WAVE_GROUPS_CACHE_KEY = 'cache_6529_wave_groups';
export const WAVE_GROUPS_VERSION_CACHE_KEY = 'cache_6529_wave_groups_version';

export async function redisGet<T>(key: string): Promise<T | null> {
  if (!redis) {
    return null;
  }
  const valueFromRedisRaw = await runFailOpenCommand<string | null>(
    'GET',
    null,
    (client) => client.get(key)
  );
  return valueFromRedisRaw ? JSON.parse(valueFromRedisRaw) : null;
}

export async function redisGetManyByIds<T>({
  prefix,
  ids
}: {
  prefix: string;
  ids: string[];
}): Promise<Record<string, T>> {
  const keys = ids.map((id) => `${prefix}:${id}`);
  const cachedValuesByKeys = await redisGetMany<T>(keys);
  return Object.entries(cachedValuesByKeys).reduce(
    (acc, [key, value]) => {
      const id = key.replace(`${prefix}:`, '');
      acc[id] = value;
      return acc;
    },
    {} as Record<string, T>
  );
}

export async function redisGetMany<T>(
  keys: string[]
): Promise<Record<string, T>> {
  if (!redis) {
    return {};
  }
  if (keys.length === 0) {
    return {};
  }
  const valuesFromRedisRaw = await runFailOpenCommand<(string | null)[]>(
    'MGET',
    [],
    (client) => client.mGet(keys)
  );
  return valuesFromRedisRaw.reduce(
    (acc: Record<string, T>, value: string | null, index: number) => {
      if (value) {
        acc[keys[index]] = JSON.parse(value);
      }
      return acc;
    },
    {} as Record<string, T>
  );
}

export async function redisCached<T>(
  key: string,
  ttl: Time,
  callback: () => Promise<T>
): Promise<T> {
  if (!redis) {
    return await callback();
  }
  const cachedValue = await redis.get(key);
  if (cachedValue) {
    return JSON.parse(cachedValue);
  }
  const value = await callback();
  if (value !== undefined) {
    await redis.set(key, JSON.stringify(value), { EX: ttl.toSeconds() });
  }
  return value;
}

/**
 * Cache write. In fail-fast mode a timed-out SET is reported as skipped but
 * may still land later, so use it only for values where last-write-wins
 * ordering does not matter (TTL-bounded cache entries).
 */
export async function redisSetJson<T>(
  key: string,
  value: T,
  ttl?: Time
): Promise<void> {
  if (!redis) {
    return;
  }
  const payload = JSON.stringify(value);
  await runFailOpenCommand<void>('SET', undefined, async (client) => {
    if (ttl) {
      await client.set(key, payload, { EX: ttl.toSeconds() });
    } else {
      await client.set(key, payload);
    }
  });
}

/** Return undefined while another instance owns a cold-cache refresh. */
export async function redisCachedWithRefreshLease<T>(
  key: string,
  ttl: Time,
  callback: () => Promise<T>
): Promise<T | undefined> {
  if (!redis) return callback();
  const client = redis;
  const cached = await client.get(key);
  if (cached !== null) return JSON.parse(cached);
  const leaseKey = `${key}:refresh-lease`;
  const token = randomUUID();
  const acquired = await client.set(leaseKey, token, { NX: true, EX: 60 });
  if (acquired === null) return undefined;
  try {
    // A preceding owner may have published between our initial GET and SET NX.
    const refreshed = await client.get(key);
    if (refreshed !== null) return JSON.parse(refreshed);
    const value = await callback();
    const published = await client.eval(
      `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
       redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
       redis.call('DEL', KEYS[1])
       return 1`,
      {
        keys: [leaseKey, key],
        arguments: [token, JSON.stringify(value), String(ttl.toSeconds())]
      }
    );
    // A slow, expired lease must not overwrite another owner's newer snapshot.
    return Number(published) === 1 ? value : undefined;
  } finally {
    await client.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then
         return redis.call('DEL', KEYS[1])
       end
       return 0`,
      { keys: [leaseKey], arguments: [token] }
    );
  }
}

/**
 * Replaces revisioned JSON only when the stored revision still matches.
 * A null expected revision seeds absent or unrevisioned/corrupt values, while
 * preserving any valid concurrent revisioned write.
 */
export async function redisCompareAndSetJson<
  T extends { readonly revision: string }
>(
  key: string,
  expectedRevision: string | null,
  value: T,
  ttl: Time
): Promise<boolean> {
  const ttlSeconds = ttl.toSeconds();
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('Redis compare-and-set TTL must be positive whole seconds');
  }
  if (!redis) {
    return false;
  }
  const result = await redis.eval(
    `
      local current = redis.call('GET', KEYS[1])
      if ARGV[1] == '' then
        if current then
          local decodedSuccessfully, decoded = pcall(cjson.decode, current)
          if decodedSuccessfully and type(decoded) == 'table' and type(decoded.revision) == 'string' and decoded.revision ~= '' then
            return 0
          end
        end
      else
        if not current then return 0 end
        local decodedSuccessfully, decoded = pcall(cjson.decode, current)
        if not decodedSuccessfully or type(decoded) ~= 'table' or decoded.revision ~= ARGV[1] then
          return 0
        end
      end
      redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
      return 1
    `,
    {
      keys: [key],
      arguments: [
        expectedRevision ?? '',
        JSON.stringify(value),
        String(ttlSeconds)
      ]
    }
  );
  return Number(result) === 1;
}

export async function evictKeyFromRedisCache(key: string): Promise<any> {
  if (!redis) {
    return;
  }
  await redis.del(key);
}
export async function evictAllKeysMatchingPatternFromRedisCache(
  pattern: string,
  singleKeyDeletes = false
) {
  logger.info(`Evicting all keys matching pattern: ${pattern}`);
  if (!redis) {
    return;
  }
  let cursor = 0;
  do {
    const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 1000 });
    cursor = Number(result.cursor);
    await deleteRedisCacheKeys(result.keys, singleKeyDeletes);
  } while (cursor !== 0);
}

async function deleteRedisCacheKeys(
  keys: string[],
  singleKeyDeletes: boolean
): Promise<void> {
  const client = redis;
  if (!client || keys.length === 0) {
    return;
  }
  if (!singleKeyDeletes) {
    await client.del(keys);
    return;
  }
  // Query variants need not share a Redis Cluster hash slot. Keep each DEL
  // single-key and bound concurrency when a scan returns many matches.
  for (let start = 0; start < keys.length; start += 20) {
    await Promise.all(
      keys.slice(start, start + 20).map((key) => client.del(key))
    );
  }
}

export function getRedisCacheKeyForPath(path: string): string {
  return `__SEIZE_CACHE_${process.env.NODE_ENV}__${path}`;
}

export function getRedisCacheKeyPatternForPath(path: string): string {
  return getRedisCacheKeyForPath(path);
}

export async function evictRedisCacheForPath(
  path: string,
  singleKeyDeletes = false
): Promise<void> {
  await evictAllKeysMatchingPatternFromRedisCache(
    getRedisCacheKeyPatternForPath(`${path}*`),
    singleKeyDeletes
  );
}

export async function evictRedisCacheForPathWithTimeout({
  path,
  timeoutMs = 1_500,
  singleKeyDeletes = false
}: {
  path: string;
  timeoutMs?: number;
  singleKeyDeletes?: boolean;
}): Promise<{
  success: boolean;
  elapsed_ms: number;
  error?: unknown;
}> {
  const startedAt = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const evictionPromise = evictRedisCacheForPath(
      path,
      singleKeyDeletes
    ).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });

    await Promise.race([
      evictionPromise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(`Timed out after ${timeoutMs}ms while evicting ${path}`)
          );
        }, timeoutMs);
      })
    ]);

    return {
      success: true,
      elapsed_ms: Date.now() - startedAt
    };
  } catch (error) {
    return {
      success: false,
      elapsed_ms: Date.now() - startedAt,
      error
    };
  }
}

const logger = Logger.get('REDIS_CLIENT');

export async function initRedis(opts?: {
  reportConnectionRecovery?: boolean;
  failFast?: RedisFailFastOptions;
}) {
  if (process.env.FORCE_AVOID_REDIS === 'true') {
    logger.warn(`Redis is disabled with FORCE_AVOID_REDIS env`);
    return;
  }
  if (redis) {
    logger.info('Redis client already initialized');
    adoptFailFastOnExistingClient(opts?.failFast);
    return;
  }
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.warn(
      `Redis is disabled. Please set REDIS_URL environment variable to enable it`
    );
    return;
  }
  const port = numbers.parseIntOrNull(process.env.REDIS_PORT) ?? 6379;
  if (port < 0 || port > 65535) {
    throw new Error(
      'REDIS_PORT env is not set or is not set to an integer between 0 and 65535'
    );
  }
  const password = process.env.REDIS_PASSWORD;
  const failFast = opts?.failFast ?? null;
  redis = createClient({
    socket: {
      host: url,
      port: port,
      tls: process.env.REDIS_TLS === 'true',
      ...(failFast && {
        connectTimeout: failFast.connectTimeoutMs,
        reconnectStrategy: (retries: number) =>
          failFastReconnectDelayMs(retries, failFast.maxReconnectDelayMs)
      })
    },
    password: password,
    // Reject commands while disconnected instead of queueing them until the
    // connection returns; callers fail open (caches) or closed (leases).
    ...(failFast && { disableOfflineQueue: true })
  });
  failFastOptions = failFast;
  let connectionFailures = 0;
  redis.on('error', (error: Error) => {
    connectionFailures++;
    if (!opts?.reportConnectionRecovery) {
      logger.error('Error connecting to Redis: ' + error);
      return;
    }
    const category = redisFailureCategory(error);
    const pending = category !== 'UNKNOWN' && connectionFailures < 3;
    logger.errorWithDiagnostic(
      {
        operation: 'REDIS_CONNECT',
        category,
        recovery: {
          state: pending ? 'pending' : 'unknown',
          attempt: connectionFailures,
          maxAttempts: 3
        }
      },
      'Redis connection failed; client is reconnecting',
      { error: error.message, consecutive_failures: connectionFailures }
    );
  });
  redis.on('connect', () => logger.info('Redis connected!'));
  redis.on('ready', () => {
    redisReadyEvents++;
    connectionFailures = 0;
  });
  redis.on('reconnecting', () => {
    redisReconnectEvents++;
  });
  if (!failFast) {
    await redis.connect();
    return;
  }
  await connectWithinBudget(redis, failFast.initialConnectTimeoutMs);
}

/**
 * Client options are fixed by the first initRedis call. A later fail-fast
 * request still bounds the helpers; a later plain call never turns fail-fast
 * off for a process that asked for it.
 */
function adoptFailFastOnExistingClient(requested?: RedisFailFastOptions) {
  if (!requested || failFastOptions) {
    return;
  }
  failFastOptions = requested;
  logger.warn(
    'Redis client was created without fail-fast options; only helper command budgets apply'
  );
}

/**
 * Waits for the first connection for at most budgetMs. On timeout the client
 * keeps reconnecting in the background and fail-fast helpers fail open until
 * it is ready, so a cold start never blocks on an unreachable Redis.
 */
async function connectWithinBudget(
  client: Redis,
  budgetMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), budgetMs);
  });
  try {
    const connected = await Promise.race([
      client.connect().then(() => true),
      budget
    ]);
    if (!connected) {
      logger.warn(
        `[REDIS NOT READY AFTER ${budgetMs}ms] Continuing without Redis while the client reconnects in the background`
      );
    }
  } catch (error) {
    logger.error(
      `[REDIS INITIAL CONNECTION FAILED] Continuing without Redis: ${error}`
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Process-local connection events for interval diagnostics; no stale timestamps. */
export function getRedisConnectionEventCounts() {
  return {
    ready: redisReadyEvents,
    reconnecting: redisReconnectEvents
  };
}

export async function clearWaveGroupsCache() {
  if (!redis) {
    return;
  }
  await Promise.all([
    redis.del(WAVE_GROUPS_CACHE_KEY),
    redis.incr(WAVE_GROUPS_VERSION_CACHE_KEY)
  ]);
}

/**
 * Evicts only the shared wave-groups entity blob. Unlike
 * clearWaveGroupsCache, this does NOT bump WAVE_GROUPS_VERSION_CACHE_KEY,
 * which would invalidate every profile's cached eligible-groups entry at
 * once. Use this when everyone whose eligibility could have changed has
 * already been (or will be) invalidated individually via
 * profile_group_changes.
 */
export async function evictWaveGroupsEntityCache() {
  if (!redis) {
    return;
  }
  await redis.del(WAVE_GROUPS_CACHE_KEY);
}

export function getRedisClient(): Redis | null {
  return redis || null;
}

/**
 * Rate limiting helper: Add entry to sorted set and get count in window
 * Uses pipeline for atomic operations
 */
export async function redisSortedSetAddAndCount(
  key: string,
  score: number,
  value: string,
  minScore: number,
  expireSeconds: number
): Promise<number> {
  if (!redis) {
    return 0;
  }

  // Fail-fast mode rejects with RedisUnavailableError instead of returning a
  // count, so the rate limiter's error path decides to fail open.
  const results = await runBoundedCommand('rate-limit pipeline', (client) => {
    const pipeline = client.multi();
    pipeline.zAdd(key, { score, value });
    pipeline.zRemRangeByScore(key, 0, minScore);
    pipeline.zCard(key);
    pipeline.expire(key, expireSeconds);
    return pipeline.exec();
  });
  if (results?.length !== 4) {
    throw new TypeError('Unexpected Redis pipeline result');
  }
  const count = results[2] as number;
  if (typeof count !== 'number') {
    throw new TypeError('Invalid count from Redis pipeline');
  }
  return count;
}
