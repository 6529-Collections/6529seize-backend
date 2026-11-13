import { NextFunction, Request, Response } from 'express';
import { getVerifiedAccessTokenWalletOrNull } from '@/api/auth/access-token-wallet';
import { Logger } from '../../../logging';
import { getJwtSecret } from '../auth/auth';
import { getIp } from '../policies/policies';
import { RateLimitResult, rateLimitingService } from './rate-limiting.service';
import {
  calculateRetryAfter,
  getRateLimitConfig,
  isSignInRequest,
  RateLimitConfig,
  rateLimitAddressKey,
  verifyInternalRequest
} from './rate-limiting.utils';
import { rateLimitFailOpenReporter } from './rate-limiting-fail-open';

const logger = Logger.get('RATE_LIMIT_MIDDLEWARE');

let configCache: ReturnType<typeof getRateLimitConfig> | null = null;

export function initRateLimiting() {
  const config = getConfig();

  if (config.enabled) {
    const internalStatus = config.internal.enabled
      ? 'Internal: enabled'
      : 'Internal: disabled';
    logger.info(
      `RATE LIMIT ENABLED - Authenticated: ${config.authenticated.burst} burst, ${config.authenticated.sustainedRps} RPS | Authenticated per address: ${config.authenticatedAddress.burst} burst, ${config.authenticatedAddress.sustainedRps} RPS | Unauthenticated: ${config.unauthenticated.burst} burst, ${config.unauthenticated.sustainedRps} RPS | Sign-in per address: ${config.signIn.burst} burst, ${config.signIn.sustainedRps} RPS | ${internalStatus}`
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
  /** `wallet:<address>` for a verified access token, else `ip:<address>`. */
  readonly identifier: string;
  readonly isAuthenticated: boolean;
  /** Source address key (IPv6 grouped by /64), or null when unknown. */
  readonly address: string | null;
}

interface RateLimitBucket {
  readonly key: string;
  readonly config: RateLimitConfig;
}

// Route-level passport authentication runs after this middleware, so req.user
// is never populated here. Verify the Bearer access token directly (same
// secret and algorithm as the JwtStrategy, no DB access); a missing, invalid
// or expired token falls back to the client IP and never rejects the request.
function getRateLimitIdentityOrNull(req: Request): RateLimitIdentity | null {
  const ip = getIp(req);
  const address = ip ? rateLimitAddressKey(ip) : null;
  const wallet = getVerifiedAccessTokenWalletOrNull(
    req.headers.authorization,
    getJwtSecret
  );
  if (wallet) {
    return {
      identifier: `wallet:${wallet}`,
      isAuthenticated: true,
      address
    };
  }
  return address
    ? { identifier: `ip:${address}`, isAuthenticated: false, address }
    : null;
}

type RateLimitSettings = ReturnType<typeof getRateLimitConfig>;

/**
 * The buckets a request consumes. The first one is its primary bucket, which
 * sets the response headers unless another bucket rejects the request.
 * - Anonymous: `ip:<address>` with the unauthenticated limits.
 * - Authenticated: `wallet:<address>` with the authenticated limits, plus
 *   `ip-auth:<address>`, a higher per source address ceiling.
 * - Sign-in nonce and login requests also consume `sign-in:<address>`.
 * - A session refresh keeps its own namespace only, as before, so refreshes
 *   never compete with the requests an app resume starts.
 */
function bucketsFor(
  req: Request,
  identity: RateLimitIdentity,
  config: RateLimitSettings
): RateLimitBucket[] {
  const isSessionRefresh =
    req.method === 'POST' &&
    /^\/api\/auth\/session-refresh\/?$/i.test(req.path);
  if (isSessionRefresh) {
    // Keep this bucket tied to the verified network identity, never a body field.
    return [
      {
        key: `session-refresh:${identity.identifier}`,
        config: config.sessionRefresh
      }
    ];
  }
  const buckets: RateLimitBucket[] = [
    {
      key: identity.identifier,
      config: identity.isAuthenticated
        ? config.authenticated
        : config.unauthenticated
    }
  ];
  if (identity.isAuthenticated && identity.address) {
    buckets.push({
      key: `ip-auth:${identity.address}`,
      config: config.authenticatedAddress
    });
  }
  if (identity.address && isSignInRequest(req.method, req.path)) {
    buckets.push({
      key: `sign-in:${identity.address}`,
      config: config.signIn
    });
  }
  return buckets;
}

/**
 * The result that answers the request: a rejecting bucket (the one that
 * resets last, so Retry-After covers every rejection), else the primary.
 */
function decidingResult(results: readonly RateLimitResult[]): RateLimitResult {
  const rejected = results.filter((result) => !result.allowed);
  if (!rejected.length) return results[0];
  return rejected.reduce(
    (latest, result) => (result.resetTime > latest.resetTime ? result : latest),
    rejected[0]
  );
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
    // 2. Wallet from a verified Bearer access token (authenticated limits),
    //    together with a per source address ceiling
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

    try {
      const results = await Promise.all(
        bucketsFor(req, identity, config).map((bucket) =>
          rateLimitingService.checkRateLimit(bucket.key, bucket.config)
        )
      );
      const result = decidingResult(results);

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
    } catch {
      // Fail open - allow request if middleware fails
      rateLimitFailOpenReporter.record('check_failed');
      next();
    }
  };
}
