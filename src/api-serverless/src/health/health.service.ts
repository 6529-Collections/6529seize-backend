import { Logger } from '../../../logging';
import { getRedisClient } from '../../../redis';
import { sqlExecutor } from '../../../sql-executor';
import { getRateLimitConfig } from '../rate-limiting/rate-limiting.utils';

const logger = Logger.get('HEALTH');
let arweaveHealthClient: { arweave: any; key: any } | null = null;

function getArweaveHealthClient(): { arweave: any; key: any } {
  if (!process.env.ARWEAVE_KEY) {
    throw new Error('ARWEAVE_KEY not set');
  }
  if (!arweaveHealthClient) {
    const ArweaveImport = require('arweave');
    const Arweave = ArweaveImport.default ?? ArweaveImport;
    const arweaveKey = JSON.parse(process.env.ARWEAVE_KEY);
    const arweave = Arweave.init({
      host: 'arweave.net',
      port: 443,
      protocol: 'https'
    });
    arweaveHealthClient = { arweave, key: arweaveKey };
  }
  return arweaveHealthClient;
}

export interface HealthData {
  status: 'ok' | 'degraded';
  version: {
    commit: string;
    node_env: string;
  };
  links: {
    api_documentation: string;
  };
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
  arweave: {
    healthy: boolean;
    wallet_address?: string;
    balance?: {
      ar: string;
      level: 'low' | 'ok' | 'high';
      estimated_50mb_uploads?: string;
      estimated_3500mb_uploads?: string;
    };
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
  let arweaveResponse: HealthData['arweave'] = {
    healthy: false
  };

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

  try {
    const { arweave, key } = getArweaveHealthClient();
    const walletAddress = await arweave.wallets.jwkToAddress(key);
    const balanceWinston = await arweave.wallets.getBalance(walletAddress);
    const balanceAr = arweave.ar.winstonToAr(balanceWinston);
    const balanceArNumber = Number.parseFloat(balanceAr);

    const balanceLevel: 'low' | 'ok' | 'high' =
      balanceArNumber > 300 ? 'high' : balanceArNumber >= 50 ? 'ok' : 'low';

    let estimated50MbUploads: string | undefined;
    let estimated3500MbUploads: string | undefined;
    try {
      const fiftyMbInBytes = 50 * 1024 * 1024;
      const fiftyMbPriceWinston = await arweave.transactions.getPrice(
        fiftyMbInBytes,
        walletAddress
      );
      const fiftyMbPriceNumber = Number.parseFloat(fiftyMbPriceWinston);
      const balanceWinstonNumber = Number.parseFloat(balanceWinston);
      if (
        Number.isFinite(fiftyMbPriceNumber) &&
        Number.isFinite(balanceWinstonNumber) &&
        fiftyMbPriceNumber > 0
      ) {
        estimated50MbUploads = Math.floor(
          balanceWinstonNumber / fiftyMbPriceNumber
        ).toString();
      }

      const threePointFiveGbInBytes = 3500 * 1024 * 1024;
      const threePointFiveGbPriceWinston = await arweave.transactions.getPrice(
        threePointFiveGbInBytes,
        walletAddress
      );
      const threePointFiveGbPriceNumber = Number.parseFloat(
        threePointFiveGbPriceWinston
      );
      if (
        Number.isFinite(threePointFiveGbPriceNumber) &&
        Number.isFinite(balanceWinstonNumber) &&
        threePointFiveGbPriceNumber > 0
      ) {
        estimated3500MbUploads = Math.floor(
          balanceWinstonNumber / threePointFiveGbPriceNumber
        ).toString();
      }
    } catch (err) {
      logger.warn('Arweave price check failed', err);
    }

    arweaveResponse = {
      healthy: true,
      wallet_address: walletAddress,
      balance: {
        ar: balanceAr,
        level: balanceLevel,
        estimated_50mb_uploads: estimated50MbUploads,
        estimated_3500mb_uploads: estimated3500MbUploads
      }
    };
  } catch (err: any) {
    logger.warn('Arweave health check failed', err);
    arweaveResponse = {
      healthy: false
    };
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
  const isArweaveOk = arweaveResponse.healthy === true;
  const overallStatus =
    isDbHealthy && isRedisOk && isArweaveOk ? 'ok' : 'degraded';

  return {
    status: overallStatus,
    version: {
      commit: process.env.GIT_COMMIT || 'unknown',
      node_env: process.env.NODE_ENV || 'unknown'
    },
    links: {
      api_documentation: '/docs'
    },
    db: isDbHealthy ? 'ok' : 'degraded',
    redis: redisResponse,
    rate_limit: rateLimitResponse,
    arweave: arweaveResponse
  };
}
