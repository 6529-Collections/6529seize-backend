import { ApiErrorDetails, CustomApiCompliantException } from '@/exceptions';
import { env } from '@/env';
import { Logger } from '@/logging';
import { rateLimitingService } from '@/api/rate-limiting/rate-limiting.service';
import {
  calculateRetryAfter,
  RateLimitConfig,
  rateLimitAddressKey
} from '@/api/rate-limiting/rate-limiting.utils';

const logger = Logger.get('CHAIN_RELAY');

/**
 * An API error answered with Retry-After: the API's error middleware sends
 * the header from `retryAfterSeconds`.
 */
export class RetryLaterException extends CustomApiCompliantException {
  constructor(
    status: number,
    message: string,
    code: string,
    readonly retryAfterSeconds: number,
    details: ApiErrorDetails = {}
  ) {
    super(status, message, code, {
      ...details,
      retry_after_seconds: retryAfterSeconds
    });
  }
}

/**
 * The relay's budgets, each `burst` a second and `sustainedRps` a second over
 * `sustainedWindowSeconds`:
 * - `wallet`: per signed-in wallet, 10 at once and 60 a minute by default,
 *   well above a person voting by hand;
 * - `address`: per source address (IPv6 by /64, as the API's limiter keys
 *   it), 40 at once and 240 a minute, so a host rotating fresh wallets gets
 *   no more than a few people behind one address;
 * - `principal`: per identity a session key signs for, 10 at once and 60 a
 *   minute, so the wallets of one identity share one budget.
 */
export interface RelayRateLimits {
  readonly wallet: RateLimitConfig;
  readonly address: RateLimitConfig;
  readonly principal: RateLimitConfig;
}

function budget(prefix: string, defaults: RateLimitConfig): RateLimitConfig {
  return {
    burst: env.getIntOrNull(`${prefix}_BURST`) ?? defaults.burst,
    sustainedRps:
      env.getIntOrNull(`${prefix}_SUSTAINED_RPS`) ?? defaults.sustainedRps,
    sustainedWindowSeconds:
      env.getIntOrNull(`${prefix}_SUSTAINED_WINDOW_SECONDS`) ??
      defaults.sustainedWindowSeconds
  };
}

export function chainRelayRateLimitsFromEnv(): RelayRateLimits {
  return {
    wallet: budget('CHAIN_RELAY_RATE_LIMIT', {
      burst: 10,
      sustainedRps: 1,
      sustainedWindowSeconds: 60
    }),
    address: budget('CHAIN_RELAY_RATE_LIMIT_IP', {
      burst: 40,
      sustainedRps: 4,
      sustainedWindowSeconds: 60
    }),
    principal: budget('CHAIN_RELAY_RATE_LIMIT_PRINCIPAL', {
      burst: 10,
      sustainedRps: 1,
      sustainedWindowSeconds: 60
    })
  };
}

/** Counts relayed writes; the API's Redis limiter by default. */
export type RelayRateLimiter = Pick<
  typeof rateLimitingService,
  'checkRateLimit'
>;

export interface RelayBucket {
  readonly kind: keyof RelayRateLimits;
  readonly id: string;
}

/**
 * The relay's rate limits. Without Redis the API's limiter admits every
 * request; the relay does too and says so once in the log.
 */
export class ChainRelayThrottle {
  private limits: RelayRateLimits | null = null;
  private failOpenLogged = false;

  constructor(
    private readonly limiter: RelayRateLimiter = rateLimitingService,
    private readonly supplier: () => RelayRateLimits = chainRelayRateLimitsFromEnv
  ) {}

  /** The signed-in wallet's and the source address's buckets. */
  static callerBuckets(wallet: string, address?: string | null) {
    const buckets: RelayBucket[] = [
      { kind: 'wallet', id: wallet.trim().toLowerCase() }
    ];
    if (address) {
      buckets.push({ kind: 'address', id: rateLimitAddressKey(address) });
    }
    return buckets;
  }

  /** Counts one write in each bucket; 429 with Retry-After when one is over. */
  async take(buckets: RelayBucket[]): Promise<void> {
    const limits = (this.limits ??= this.supplier());
    const results = await Promise.all(
      buckets.map((it) =>
        this.limiter.checkRateLimit(
          `chain-relay:${it.kind}:${it.id}`,
          limits[it.kind]
        )
      )
    );
    if (!this.failOpenLogged && results.some((it) => it.failedOpen)) {
      this.failOpenLogged = true;
      logger.warn(
        '[RELAY RATE LIMIT NOT ENFORCED] the limiter could not be read (no Redis): relayed writes are admitted unchecked'
      );
    }
    const refused = results.filter((it) => !it.allowed);
    if (!refused.length) return;
    const seconds = calculateRetryAfter(
      Math.max(...refused.map((it) => it.resetTime))
    );
    throw new RetryLaterException(
      429,
      `Too many operations sent: try again in ${seconds} s`,
      'CHAIN_RELAY_RATE_LIMITED',
      seconds
    );
  }
}
