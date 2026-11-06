import { env } from '@/env';
import { getRedisClient } from '@/redis';
import { rateLimitingService } from '@/api/rate-limiting/rate-limiting.service';
import { RateLimitConfig } from '@/api/rate-limiting/rate-limiting.utils';
import {
  TelemetryDailySalt,
  telemetryDailyHash
} from '@/api/telemetry/telemetry-daily-salt';

export type TelemetryRateLimitScope = 'ingest' | 'diag';

function getConfig(scope: TelemetryRateLimitScope): RateLimitConfig {
  if (scope === 'diag') {
    // 5 bundles per visitor per hour.
    return {
      burst: 2,
      sustainedRps: (env.getIntOrNull('TELEMETRY_DIAG_PER_HOUR') ?? 5) / 3600,
      sustainedWindowSeconds: 3600
    };
  }
  // Page-view and page-hide beacons: generous enough for busy shared IPs.
  return {
    burst: env.getIntOrNull('TELEMETRY_INGEST_BURST') ?? 20,
    sustainedRps: env.getIntOrNull('TELEMETRY_INGEST_SUSTAINED_RPS') ?? 5,
    sustainedWindowSeconds: 60
  };
}

/**
 * The limiter's Redis key is an HMAC of the viewer IP under the daily salt,
 * never the IP itself. Redis keeps the key in memory for at most the window
 * (one hour for diagnostics); nothing reaches MySQL or logs. Without Redis
 * or without an IP the request is allowed (the CDN WAF rate rule remains).
 */
export function telemetryRateLimitIdentifier(
  scope: TelemetryRateLimitScope,
  ip: string,
  salt: TelemetryDailySalt
): string {
  return `telemetry-${scope}:${telemetryDailyHash(salt, 'rate-limit', scope, ip).slice(0, 32)}`;
}

export async function isTelemetryRateLimited(
  scope: TelemetryRateLimitScope,
  ip: string,
  salt: TelemetryDailySalt
): Promise<boolean> {
  if (!ip || !getRedisClient()) {
    return false;
  }
  const result = await rateLimitingService.checkRateLimit(
    telemetryRateLimitIdentifier(scope, ip, salt),
    getConfig(scope)
  );
  return !result.allowed;
}
