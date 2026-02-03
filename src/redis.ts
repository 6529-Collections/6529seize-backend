import { createClient, RedisClientType as Redis } from 'redis';
import { Logger } from './logging';
import { numbers } from './numbers';
import { Time } from './time';

let redis: Redis;

export async function redisGet<T>(key: string): Promise<T | null> {
  if (!redis) {
    return null;
  }
  const valueFromRedisRaw = await redis.get(key);
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
  const valuesFromRedisRaw = await redis.mGet(keys);
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

export async function redisSetJson<T>(
  key: string,
  value: T,
  ttl?: Time
): Promise<void> {
  if (!redis) {
    return;
  }
  const payload = JSON.stringify(value);
  if (ttl) {
    await redis.set(key, payload, { EX: ttl.toSeconds() });
  } else {
    await redis.set(key, payload);
  }
}

export async function evictKeyFromRedisCache(key: string): Promise<any> {
  if (!redis) {
    return;
  }
  await redis.del(key);
}
export async function evictAllKeysMatchingPatternFromRedisCache(
  pattern: string
) {
  logger.info(`Evicting all keys matching pattern: ${pattern}`);
  if (!redis) {
    return;
  }
  let cursor = 0;
  do {
    const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = result.cursor;
    if (result.keys.length > 0) {
      await redis.del(result.keys);
    }
  } while (cursor !== 0);
}

const logger = Logger.get('REDIS_CLIENT');

export async function initRedis() {
  if (process.env.FORCE_AVOID_REDIS === 'true') {
    logger.warn(`Redis is disabled with FORCE_AVOID_REDIS env`);
    return;
  }
  if (redis) {
    logger.info('Redis client already initialized');
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
  redis = createClient({
    socket: {
      host: url,
      port: port,
      tls: process.env.REDIS_TLS === 'true'
    },
    password: password
  });
  redis.on('error', (error: Error) =>
    logger.error('Error connecting to Redis: ' + error)
  );
  redis.on('connect', () => logger.info('Redis connected!'));
  await redis.connect();
}

export async function clearWaveGroupsCache() {
  await evictKeyFromRedisCache('cache_6529_wave_groups');
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

  const pipeline = redis.multi();
  pipeline.zAdd(key, { score, value });
  pipeline.zRemRangeByScore(key, 0, minScore);
  pipeline.zCard(key);
  pipeline.expire(key, expireSeconds);

  const results = await pipeline.exec();
  if (results?.length !== 4) {
    throw new TypeError('Unexpected Redis pipeline result');
  }
  const count = results[2] as number;
  if (typeof count !== 'number') {
    throw new TypeError('Invalid count from Redis pipeline');
  }
  return count;
}
