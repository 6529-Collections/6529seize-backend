import { randomUUID } from 'node:crypto';
import { getRedisClient } from '@/redis';
import { Time } from '@/time';

const DISTRIBUTED_WINDOW_MS = 60_000;
const DISTRIBUTED_LIMIT = 60;

export class OpenSeaDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, OpenSeaDeadlineError.prototype);
  }
}

interface OpenSeaRateLimiterOptions {
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Shares the existing market-depth quota with legacy collection price requests. */
export class OpenSeaRateLimiter {
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private localNextRequestAt = 0;

  constructor(options: OpenSeaRateLimiterOptions = {}) {
    this.sleep =
      options.sleep ?? ((milliseconds) => Time.millis(milliseconds).sleep());
    this.now = options.now ?? (() => Date.now());
  }

  async acquire(deadlineMs: number): Promise<void> {
    const redis = getRedisClient();
    const limit = envPositiveInteger(
      'OPENSEA_SHARED_REQUESTS_PER_MINUTE',
      DISTRIBUTED_LIMIT
    );
    if (!redis) {
      const interval = Math.ceil(DISTRIBUTED_WINDOW_MS / limit);
      const wait = Math.max(0, this.localNextRequestAt - this.now());
      if (this.now() + wait >= deadlineMs)
        throw new OpenSeaDeadlineError(
          'OpenSea request deadline exceeded while rate limited'
        );
      if (wait > 0) await this.sleep(wait);
      this.localNextRequestAt = this.now() + interval;
      return;
    }

    for (;;) {
      const now = this.now();
      const result = (await redis.eval(
        `local key=KEYS[1]
         local now=tonumber(ARGV[1])
         local window=tonumber(ARGV[2])
         local limit=tonumber(ARGV[3])
         redis.call('ZREMRANGEBYSCORE', key, '-inf', now-window)
         local count=redis.call('ZCARD', key)
         if count < limit then
           redis.call('ZADD', key, now, ARGV[4])
           redis.call('PEXPIRE', key, window)
           return 0
         end
         local oldest=redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
         return math.max(1, window-(now-tonumber(oldest[2])))`,
        {
          keys: ['opensea:market-depth:requests'],
          arguments: [
            String(now),
            String(DISTRIBUTED_WINDOW_MS),
            String(limit),
            randomUUID()
          ]
        }
      )) as number;
      const wait = Number(result);
      if (wait <= 0) return;
      if (now + wait >= deadlineMs)
        throw new OpenSeaDeadlineError(
          'OpenSea request deadline exceeded while rate limited'
        );
      await this.sleep(wait);
    }
  }
}
