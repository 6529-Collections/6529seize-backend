import { createClient, RedisClientType as Redis } from 'redis';
import { Logger } from './logging';
import { Time } from './time';
import { numbers } from './numbers';

let redis: Redis;

export async function redisGet<T>(key: string): Promise<T | null> {
  if (!redis) {
    throw new Error('Redis client is not initialized');
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
    throw new Error('Redis client is not initialized');
  }
  if (keys.length === 0) {
    return {};
  }
  const valuesFromRedisRaw = await redis.mGet(keys);
  return valuesFromRedisRaw.reduce(
    (acc, value, index) => {
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
): Promise<any> {
  if (!redis) {
    return await callback();
  }
  const cachedValue = await redis.get(key);
  if (cachedValue) {
    return JSON.parse(cachedValue);
  }
  const value = await callback();
  if (value !== undefined) {
    await redis.set(key, JSON.stringify(value), { EX: ttl.toMillis() });
  }
  return value;
}

export async function evictKeyFromRedisCache(key: string): Promise<any> {
  await redis.del(key);
}
export async function evictAllKeysMatchingPatternFromRedisCache(
  pattern: string
) {
  if (redis) {
    const keys = await redis.keys(pattern);
    await Promise.all(keys.map((it) => redis.del(it)));
  }
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
  redis.on('error', (error) =>
    logger.error('Error connecting to Redis: ' + error)
  );
  redis.on('connect', () => logger.info('Redis connected!'));
  await redis.connect();
}

export async function clearWaveGroupsCache() {
  await evictKeyFromRedisCache('cache_6529_wave_groups');
}
