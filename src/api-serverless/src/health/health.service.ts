import { Logger } from '../../../logging';
import { getRedisClient } from '../../../redis';
import { sqlExecutor } from '../../../sql-executor';
import { getRateLimitConfig } from '../rate-limiting/rate-limiting.utils';

const logger = Logger.get('HEALTH');

export interface HealthData {
  status: 'ok' | 'degraded';
  db: 'ok' | 'degraded';
  redis: {
    enabled: boolean;
    healthy?: boolean;
  };
  rate_limit: {
    enabled: boolean;
    authenticated?: {
      burst: number;
      sustained_rps: number;
      sustained_window_seconds: number;
    };
    unauthenticated?: {
      burst: number;
      sustained_rps: number;
      sustained_window_seconds: number;
    };
    internal_enabled?: boolean;
  };
  version: {
    commit: string;
    node_env: string;
  };
}

export async function getHealthData(): Promise<HealthData> {
  let isDbHealthy = false;
  try {
    await sqlExecutor.execute('SELECT 1');
    isDbHealthy = true;
  } catch (err) {
    logger.warn('Database health check failed', err);
    isDbHealthy = false;
  }

  let redis: ReturnType<typeof getRedisClient> | null = null;
  let isRedisHealthy: boolean | undefined;

  try {
    redis = getRedisClient();
    if (redis) {
      await redis.ping();
      isRedisHealthy = true;
    }
  } catch (err) {
    logger.warn('Redis health check failed', err);
    isRedisHealthy = false;
  }

  const redisEnabled = !!redis;

  const redisResponse: any = {
    enabled: redisEnabled
  };
  if (redisEnabled) {
    redisResponse.healthy = isRedisHealthy;
  }

  let rateLimitResponse: any;
  try {
    const rateLimitingConfig = getRateLimitConfig();
    if (rateLimitingConfig.enabled) {
      rateLimitResponse = {
        enabled: true,
        authenticated: {
          burst: rateLimitingConfig.authenticated.burst,
          sustained_rps: rateLimitingConfig.authenticated.sustainedRps,
          sustained_window_seconds:
            rateLimitingConfig.authenticated.sustainedWindowSeconds
        },
        unauthenticated: {
          burst: rateLimitingConfig.unauthenticated.burst,
          sustained_rps: rateLimitingConfig.unauthenticated.sustainedRps,
          sustained_window_seconds:
            rateLimitingConfig.unauthenticated.sustainedWindowSeconds
        },
        internal_enabled: rateLimitingConfig.internal.enabled
      };
    } else {
      rateLimitResponse = {
        enabled: false
      };
    }
  } catch (err) {
    logger.warn('Rate limit config check failed', err);
    rateLimitResponse = {
      enabled: false
    };
  }

  const isRedisOk = !redisEnabled || isRedisHealthy === true;
  const overallStatus = isDbHealthy && isRedisOk ? 'ok' : 'degraded';

  return {
    status: overallStatus,
    db: isDbHealthy ? 'ok' : 'degraded',
    redis: redisResponse,
    rate_limit: rateLimitResponse,
    version: {
      commit: process.env.GIT_COMMIT || 'unknown',
      node_env: process.env.NODE_ENV || 'unknown'
    }
  };
}
