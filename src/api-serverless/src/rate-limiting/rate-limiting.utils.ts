import { env } from '../../../env';

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

export function generateBurstKey(identifier: string, windowStart: number): string {
  return `rate_limit:burst:${identifier}:${windowStart}`;
}

export function generateSustainedKey(
  identifier: string,
  windowStart: number
): string {
  return `rate_limit:sustained:${identifier}:${windowStart}`;
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

