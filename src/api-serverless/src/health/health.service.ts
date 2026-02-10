import { Logger } from '../../../logging';
import { getRedisClient } from '../../../redis';
import { sqlExecutor } from '../../../sql-executor';
import { getRateLimitConfig } from '../rate-limiting/rate-limiting.utils';

const logger = Logger.get('HEALTH');
let arweaveHealthClient: { arweave: any; key: any } | null = null;
const ARWEAVE_HEALTH_TIMEOUT_MS = 5_000;
const ARWEAVE_HEALTH_CACHE_TTL_MS = 60_000;
let arweaveHealthCache: {
  data: HealthData['arweave'];
  expiresAt: number;
} | null = null;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
  });
}

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

function resolveArweaveBalanceLevel(
  balanceArNumber: number
): 'low' | 'ok' | 'high' {
  if (balanceArNumber > 300) {
    return 'high';
  }
  if (balanceArNumber >= 50) {
    return 'ok';
  }
  return 'low';
}

async function fetchArweaveHealthUncached(): Promise<HealthData['arweave']> {
  const { arweave, key } = getArweaveHealthClient();
  const walletAddress = await arweave.wallets.jwkToAddress(key);
  const balanceWinston = await arweave.wallets.getBalance(walletAddress);
  const balanceAr = arweave.ar.winstonToAr(balanceWinston);
  const balanceArNumber = Number.parseFloat(balanceAr);

  const balanceLevel = resolveArweaveBalanceLevel(balanceArNumber);

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

  return {
    healthy: true,
    wallet_address: walletAddress,
    balance: {
      ar: balanceAr,
      level: balanceLevel,
      estimated_50mb_uploads: estimated50MbUploads,
      estimated_3500mb_uploads: estimated3500MbUploads
    }
  };
}

async function getArweaveHealthCached(): Promise<HealthData['arweave']> {
  const now = Date.now();
  if (arweaveHealthCache && arweaveHealthCache.expiresAt > now) {
    return arweaveHealthCache.data;
  }

  const response = await withTimeout(
    fetchArweaveHealthUncached(),
    ARWEAVE_HEALTH_TIMEOUT_MS,
    'Arweave health check timed out'
  );

  if (response.healthy) {
    arweaveHealthCache = {
      data: response,
      expiresAt: now + ARWEAVE_HEALTH_CACHE_TTL_MS
    };
  }

  return response;
}

async function checkDbHealth(): Promise<boolean> {
  try {
    await sqlExecutor.execute('SELECT 1');
    return true;
  } catch (err) {
    logger.warn('Database health check failed', err);
    return false;
  }
}

async function getRedisHealth(): Promise<{
  response: HealthData['redis'];
  isOk: boolean;
}> {
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

  const enabled = !!redis;
  const response: HealthData['redis'] = { enabled };
  if (enabled) {
    response.healthy = isRedisHealthy;
  }

  return {
    response,
    isOk: !enabled || isRedisHealthy === true
  };
}

async function getArweaveHealthSafe(): Promise<HealthData['arweave']> {
  try {
    return await getArweaveHealthCached();
  } catch (err: any) {
    logger.warn('Arweave health check failed', err);
    return {
      healthy: false
    };
  }
}

function getRateLimitHealth(): HealthData['rate_limit'] {
  try {
    const rateLimitingConfig = getRateLimitConfig();
    if (!rateLimitingConfig.enabled) {
      return {
        enabled: false
      };
    }

    return {
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
  } catch (err) {
    logger.warn('Rate limit config check failed', err);
    return {
      enabled: false
    };
  }
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
  const isDbHealthy = await checkDbHealth();
  const { response: redisResponse, isOk: isRedisOk } = await getRedisHealth();
  const arweaveResponse = await getArweaveHealthSafe();
  const rateLimitResponse = getRateLimitHealth();
  const overallStatus =
    isDbHealthy && isRedisOk && arweaveResponse.healthy ? 'ok' : 'degraded';

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
