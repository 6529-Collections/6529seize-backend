import { NextFunction, Request, Response } from 'express';
import { Logger } from '../../../logging';
import { getAuthenticatedWalletOrNull } from '../auth/auth';
import { getIp } from '../policies/policies';
import { rateLimitingService } from './rate-limiting.service';
import { calculateRetryAfter, getRateLimitConfig } from './rate-limiting.utils';

const logger = Logger.get('RATE_LIMIT_MIDDLEWARE');

let configCache: ReturnType<typeof getRateLimitConfig> | null = null;

function getConfig() {
  if (!configCache) {
    configCache = getRateLimitConfig();
  }
  return configCache;
}

// Export function to clear cache (useful for testing)
export function clearConfigCache() {
  configCache = null;
}

export function rateLimitingMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const config = getConfig();

    // If rate limiting is disabled, skip
    if (!config.enabled) {
      return next();
    }

    // Get user identifier: authenticated wallet or IP address
    const authenticatedWallet = getAuthenticatedWalletOrNull(req);
    const identifier = authenticatedWallet
      ? `wallet:${authenticatedWallet.toLowerCase()}`
      : `ip:${getIp(req)}`;

    if (!identifier || identifier === 'ip:') {
      // If we can't identify the user, allow the request
      logger.warn(
        'Could not identify user for rate limiting, allowing request'
      );
      return next();
    }

    // Select appropriate config based on authentication status
    const rateLimitConfig = authenticatedWallet
      ? config.authenticated
      : config.unauthenticated;

    try {
      const result = await rateLimitingService.checkRateLimit(
        identifier,
        rateLimitConfig
      );

      // Add rate limit headers to all responses
      const limit = result.limit;
      const remaining = result.remaining;
      const resetTime = result.resetTime;

      res.setHeader('X-RateLimit-Limit', limit.toString());
      res.setHeader('X-RateLimit-Remaining', remaining.toString());
      res.setHeader(
        'X-RateLimit-Reset',
        Math.ceil(resetTime / 1000).toString()
      );

      if (!result.allowed) {
        const retryAfter = calculateRetryAfter(resetTime);
        res.setHeader('Retry-After', retryAfter.toString());
        res.status(429).json({
          error: 'Rate limit exceeded',
          message: 'Too many requests, please try again later',
          retryAfter
        });
        return;
      }

      next();
    } catch (error) {
      logger.error(`Rate limiting middleware error: ${error}`);
      // Fail open - allow request if middleware fails
      next();
    }
  };
}
