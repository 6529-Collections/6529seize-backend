import { NextFunction, Request, Response } from 'express';
import { getVerifiedAccessTokenWalletOrNull } from '@/api/auth/access-token-wallet';
import { Logger } from '../../../logging';
import { getJwtSecret } from '../auth/auth';
import { getIp } from '../policies/policies';
import { rateLimitingService } from './rate-limiting.service';
import {
  calculateRetryAfter,
  getRateLimitConfig,
  verifyInternalRequest
} from './rate-limiting.utils';

const logger = Logger.get('RATE_LIMIT_MIDDLEWARE');

let configCache: ReturnType<typeof getRateLimitConfig> | null = null;

export function initRateLimiting() {
  const config = getConfig();

  if (config.enabled) {
    const internalStatus = config.internal.enabled
      ? 'Internal: enabled'
      : 'Internal: disabled';
    logger.info(
      `RATE LIMIT ENABLED - Authenticated: ${config.authenticated.burst} burst, ${config.authenticated.sustainedRps} RPS | Unauthenticated: ${config.unauthenticated.burst} burst, ${config.unauthenticated.sustainedRps} RPS | ${internalStatus}`
    );
  } else {
    logger.info('RATE LIMIT DISABLED');
  }
}

function getConfig() {
  configCache ??= getRateLimitConfig();
  return configCache;
}

// Export function to clear cache (useful for testing)
export function clearConfigCache() {
  configCache = null;
}

interface RateLimitIdentity {
  readonly identifier: string;
  readonly isAuthenticated: boolean;
}

// Route-level passport authentication runs after this middleware, so req.user
// is never populated here. Verify the Bearer access token directly (same
// secret and algorithm as the JwtStrategy, no DB access); a missing, invalid
// or expired token falls back to the client IP and never rejects the request.
function getRateLimitIdentityOrNull(req: Request): RateLimitIdentity | null {
  const wallet = getVerifiedAccessTokenWalletOrNull(
    req.headers.authorization,
    getJwtSecret
  );
  if (wallet) {
    return { identifier: `wallet:${wallet}`, isAuthenticated: true };
  }
  const ip = getIp(req);
  return ip ? { identifier: `ip:${ip}`, isAuthenticated: false } : null;
}

export function rateLimitingMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const config = getConfig();

    // If rate limiting is disabled, skip
    if (!config.enabled) {
      return next();
    }

    // Identity priority:
    // 1. Signed Internal Request (for server-side requests from web app)
    //    - Must include: X-6529-Internal-Id, X-6529-Internal-Timestamp, X-6529-Internal-Signature
    //    - Signature: HMAC-SHA256(secret, `${clientId}\n${timestamp}\n${method}\n${path}`)
    //    - Timestamp tolerance: 5 minutes
    //    Checked first: server-side requests also forward the viewer's Bearer
    //    token and must not consume that wallet's budget.
    // 2. Wallet from a verified Bearer access token (authenticated limits)
    // 3. Client IP from the API Gateway source IP (never X-Forwarded-For)
    if (verifyInternalRequest(req, config.internal)) {
      // Verified internal requests skip rate limiting entirely
      // The signature ensures only the web app (with the secret) can generate valid requests
      logger.info(
        '[SSR REQUEST] Received signed internal request, skipping rate limiting'
      );
      return next();
    }

    const identity = getRateLimitIdentityOrNull(req);
    if (!identity) {
      // If we can't identify the user, allow the request
      logger.warn(
        'Could not identify user for rate limiting, allowing request'
      );
      return next();
    }
    const { isAuthenticated } = identity;
    let { identifier } = identity;

    // Select appropriate config based on authentication status
    const isSessionRefresh =
      req.method === 'POST' &&
      /^\/api\/auth\/session-refresh\/?$/i.test(req.path);
    // Refreshes must not compete with the API requests started on app resume.
    // Keep this bucket tied to the verified network identity, never a body field.
    if (isSessionRefresh) {
      identifier = `session-refresh:${identifier}`;
    }
    const ordinaryConfig = isAuthenticated
      ? config.authenticated
      : config.unauthenticated;
    const rateLimitConfig = isSessionRefresh
      ? config.sessionRefresh
      : ordinaryConfig;

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
