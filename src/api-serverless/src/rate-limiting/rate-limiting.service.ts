import { randomBytes } from 'crypto';
import { Logger } from '../../../logging';
import { getRedisClient, redisSortedSetAddAndCount } from '../../../redis';
import {
  RateLimitConfig,
  generateBurstKey,
  generateSustainedKey,
  sanitizeIdentifier
} from './rate-limiting.utils';

const logger = Logger.get('RATE_LIMIT_SERVICE');

// Generate a unique value for Redis sorted set entries
function generateUniqueValue(timestamp: number): string {
  // Use 4 random bytes (8 hex chars) for uniqueness
  const randomSuffix = randomBytes(4).toString('hex');
  return `${timestamp}-${randomSuffix}`;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  limit: number;
}

export class RateLimitingService {
  async checkRateLimit(
    identifier: string,
    config: RateLimitConfig
  ): Promise<RateLimitResult> {
    const redis = getRedisClient();
    if (!redis) {
      // If Redis is not available, allow the request (fail open)
      logger.warn('Redis not available, allowing request');
      return {
        allowed: true,
        remaining: config.burst,
        resetTime: Date.now() + 1000,
        limit: config.burst
      };
    }

    const sanitizedId = sanitizeIdentifier(identifier);
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);

    try {
      // Check burst limit (1 second window)
      const burstResult = await this.checkBurstLimit(
        sanitizedId,
        config.burst,
        nowSeconds
      );

      if (!burstResult.allowed) {
        return burstResult;
      }

      // Check sustained limit (configurable window)
      const sustainedResult = await this.checkSustainedLimit(
        sanitizedId,
        config.sustainedRps,
        config.sustainedWindowSeconds,
        nowSeconds
      );

      if (!sustainedResult.allowed) {
        return sustainedResult;
      }

      // Both checks passed, return the more restrictive remaining count
      return {
        allowed: true,
        remaining: Math.min(burstResult.remaining, sustainedResult.remaining),
        resetTime: Math.max(burstResult.resetTime, sustainedResult.resetTime),
        limit: Math.min(burstResult.limit, sustainedResult.limit)
      };
    } catch (error) {
      logger.error(`Rate limit check failed: ${error}`);
      // Fail open - allow request if rate limiting fails
      return {
        allowed: true,
        remaining: config.burst,
        resetTime: Date.now() + 1000,
        limit: config.burst
      };
    }
  }

  private async checkBurstLimit(
    identifier: string,
    limit: number,
    currentSecond: number
  ): Promise<RateLimitResult> {
    const key = generateBurstKey(identifier, currentSecond);
    const windowStart = currentSecond * 1000;
    const windowEnd = windowStart + 1000;
    const now = Date.now();

    const count = await redisSortedSetAddAndCount(
      key,
      now,
      generateUniqueValue(now),
      windowStart - 1,
      2 // Expire after 2 seconds
    );

    const remaining = Math.max(0, limit - count);
    const allowed = count < limit;

    return {
      allowed,
      remaining,
      resetTime: windowEnd,
      limit
    };
  }

  private async checkSustainedLimit(
    identifier: string,
    rpsLimit: number,
    windowSeconds: number,
    currentSecond: number
  ): Promise<RateLimitResult> {
    // Use a sliding window approach
    // We track requests in the last `windowSeconds` seconds using a single key per identifier
    const key = generateSustainedKey(identifier);
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    const count = await redisSortedSetAddAndCount(
      key,
      now,
      generateUniqueValue(now),
      windowStart,
      windowSeconds + 1 // Expire after window + 1 second
    );

    // Calculate allowed requests per second in the window
    const maxRequests = rpsLimit * windowSeconds;
    const remaining = Math.max(0, maxRequests - count);
    const allowed = count < maxRequests;

    // Reset time is when the oldest request in the window expires
    const resetTime = now + windowSeconds * 1000;

    return {
      allowed,
      remaining: Math.floor(remaining / windowSeconds), // Convert to per-second remaining
      resetTime,
      limit: rpsLimit
    };
  }
}

export const rateLimitingService = new RateLimitingService();
