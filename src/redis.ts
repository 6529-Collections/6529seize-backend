import { createClient, RedisClientType as Redis } from 'redis';
import { parseIntOrNull } from './helpers';
import { Logger } from './logging';
import { Time } from './time';

let redis: Redis;

export async function redisCached<T>(
  key: string,
  ttl: Time,
  callback: () => Promise<T>
): Promise<any> {
  if (!redis) {
    throw new Error('Redis client is not initialized');
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
  if (!redis) {
    throw new Error('Redis client is not initialized');
  }
  await redis.del(key);
}
export async function evictAllKeysMatchingPatternFromRedisCache(
  pattern: string
) {
  if (!redis) {
    throw new Error('Redis client is not initialized');
  }
  const keys = await redis.keys(pattern);
  await Promise.all(keys.map((it) => redis.del(it)));
}

const logger = Logger.get('REDIS_CLIENT');

export async function initRedis() {
  if (redis) {
    logger.info('Redis client already initialized');
    return;
  }
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL env is not set');
  }
  const port = parseIntOrNull(process.env.REDIS_PORT);
  if (port === null || port < 0 || port > 65535) {
    throw new Error(
      'REDIS_PORT env is not set or is not set to an integer between 0 and 65535'
    );
  }
  const password = process.env.REDIS_PASSWORD;
  logger.info(
    `Creating reddis client with url: ${url}, port: ${port} and password: ${password}`
  );
  redis = createClient({
    socket: {
      host: url,
      port: port,
      tls: true
    },
    password: password
  });
  redis.on('error', (error) => logger.error('Error: ' + error));
  redis.on('connect', () => logger.info('Connected!'));
  logger.info('starting to connect');
  await redis.connect();
  logger.info('finished connecting');
}

export async function disconnectRedis() {
  if (redis) {
    await redis.disconnect();
    logger.info('Disconnected!');
  }
}
