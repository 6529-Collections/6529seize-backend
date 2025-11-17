import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../../env';
import { Logger } from '../../../logging';

const logger = Logger.get('RATE_LIMIT_UTILS');

export interface RateLimitConfig {
  burst: number;
  sustainedRps: number;
  sustainedWindowSeconds: number;
}

export function getRateLimitConfig(): {
  enabled: boolean;
  authenticated: RateLimitConfig;
  unauthenticated: RateLimitConfig;
} {
  const enabled =
    env.getStringOrNull('RATE_LIMIT_ENABLED') !== 'false' &&
    env.getStringOrNull('RATE_LIMIT_ENABLED') !== '0';

  return {
    enabled,
    authenticated: {
      burst: env.getIntOrNull('RATE_LIMIT_AUTH_BURST') ?? 30,
      sustainedRps: env.getIntOrNull('RATE_LIMIT_AUTH_SUSTAINED_RPS') ?? 10,
      sustainedWindowSeconds:
        env.getIntOrNull('RATE_LIMIT_AUTH_SUSTAINED_WINDOW_SECONDS') ?? 60
    },
    unauthenticated: {
      burst: env.getIntOrNull('RATE_LIMIT_UNAUTH_BURST') ?? 20,
      sustainedRps: env.getIntOrNull('RATE_LIMIT_UNAUTH_SUSTAINED_RPS') ?? 5,
      sustainedWindowSeconds:
        env.getIntOrNull('RATE_LIMIT_UNAUTH_SUSTAINED_WINDOW_SECONDS') ?? 60
    }
  };
}

export function generateBurstKey(
  identifier: string,
  windowStart: number
): string {
  return `rate_limit:burst:${identifier}:${windowStart}`;
}

export function generateSustainedKey(identifier: string): string {
  // Use a single key per identifier for sliding window tracking
  // The sliding window is managed via timestamps in the sorted set, not separate keys
  return `rate_limit:sustained:${identifier}`;
}

export function calculateRetryAfter(resetTime: number): number {
  const now = Date.now();
  const retryAfter = Math.ceil((resetTime - now) / 1000);
  return Math.max(1, retryAfter);
}

export function sanitizeIdentifier(identifier: string): string {
  // Remove any characters that could be problematic in Redis keys
  return identifier.replace(/[^a-zA-Z0-9:._-]/g, '_');
}

/**
 * Verifies a signed internal request using HMAC with timestamp
 * The web app should sign: HMAC-SHA256(secret, `${clientId}\n${timestamp}\n${method}\n${path}`)
 * @param req - Express request object
 * @returns true if the signature is valid
 */
export function verifyInternalRequest(req: Request): boolean {
  const clientId = req.headers['x-6529-internal-id'] as string | undefined;
  const timestamp = req.headers['x-6529-internal-timestamp'] as
    | string
    | undefined;
  const signature = req.headers['x-6529-internal-signature'] as
    | string
    | undefined;

  const expectedInternalId = env.getStringOrNull('RATE_LIMIT_INTERNAL_ID');
  if (!expectedInternalId) {
    return false;
  }

  if (clientId !== expectedInternalId) {
    return false;
  }

  if (!timestamp || !signature) {
    return false;
  }

  const timestampNum = Number.parseInt(timestamp, 10);
  if (!timestampNum) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampNum) > 300) {
    return false;
  }

  const secret = env.getStringOrNull('RATE_LIMIT_INTERNAL_SECRET');
  if (!secret) {
    return false;
  }

  try {
    // Use path with query string to match web app's pathname + search format
    // Uppercase method to match web app's .toUpperCase() call
    const pathWithQuery =
      req.path +
      (req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '');
    const method = req.method.toUpperCase();
    const payload = `${clientId}\n${timestampNum}\n${method}\n${pathWithQuery}`;
    const expected = createHmac('sha256', secret).update(payload).digest('hex');

    const signatureBuffer = new Uint8Array(Buffer.from(signature, 'hex'));
    const expectedBuffer = new Uint8Array(Buffer.from(expected, 'hex'));
    return timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch (error) {
    logger.error(`Error verifying internal request signature: ${error}`);
    return false;
  }
}
