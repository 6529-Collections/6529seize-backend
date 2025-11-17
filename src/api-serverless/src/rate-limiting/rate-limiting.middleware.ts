import { NextFunction, Request, Response } from 'express';
import { Logger } from '../../../logging';
import { getAuthenticatedWalletOrNull } from '../auth/auth';
import { getIp } from '../policies/policies';
import { rateLimitingService } from './rate-limiting.service';
import {
  calculateRetryAfter,
  getRateLimitConfig,
  verifyInternalRequest
} from './rate-limiting.utils';

const logger = Logger.get('RATE_LIMIT_MIDDLEWARE');

let configCache: ReturnType<typeof getRateLimitConfig> | null = null;

function getConfig() {
  configCache ??= getRateLimitConfig();
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

    // Get user identifier with priority:
    // 1. Authenticated wallet (highest priority - most specific)
    // 2. Signed Internal Request (for server-side requests from web app)
    //    - Must include: X-6529-Internal-Id, X-6529-Internal-Timestamp, X-6529-Internal-Signature
    //    - Signature: HMAC-SHA256(secret, `${clientId}\n${timestamp}\n${method}\n${path}`)
    //    - Timestamp tolerance: 5 minutes
    // 3. IP address (fallback)
    const authenticatedWallet = getAuthenticatedWalletOrNull(req);
    const ip = getIp(req);

    let identifier: string;
    let isAuthenticated: boolean;

    if (authenticatedWallet) {
      identifier = `wallet:${authenticatedWallet.toLowerCase()}`;
      isAuthenticated = true;
    } else if (verifyInternalRequest(req)) {
      // Use internal request identifier for server-side requests (e.g., from Elastic Beanstalk)
      // The signature ensures only the web app (with the secret) can generate valid requests
      // This allows SSR requests to bypass IP-based rate limiting
      identifier = 'internal:ssr';
      isAuthenticated = false; // Use unauthenticated config for internal requests
      logger.info(
        `[SSR REQUEST] Received signed internal request for path ${req.path}, skipping IP-based rate limiting`
      );
    } else if (ip) {
      identifier = `ip:${ip}`;
      isAuthenticated = false;
    } else {
      identifier = '';
      isAuthenticated = false;
    }

    if (!identifier || identifier === 'ip:') {
      // If we can't identify the user, allow the request
      logger.warn(
        'Could not identify user for rate limiting, allowing request'
      );
      return next();
    }

    // Select appropriate config based on authentication status
    const rateLimitConfig = isAuthenticated
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
          retryAfter,
          source: '6529-api'
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
