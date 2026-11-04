import { randomUUID } from 'node:crypto';
import { getRedisClient } from '@/redis';
import { Time } from '@/time';

const DISTRIBUTED_WINDOW_MS = 60_000;
const DISTRIBUTED_LIMIT = 60;
const REQUESTS_KEY = 'opensea:market-depth:requests';
const PACING_KEY = 'opensea:market-depth:next-request';
const COOLDOWN_KEY = 'opensea:market-depth:cooldown';

// Retain the rolling-window key so older workers still share the same quota
// during deployment. New workers also space grants and observe shared cooldowns.
const ACQUIRE_SCRIPT = `
  local now=tonumber(ARGV[1])
  local window=tonumber(ARGV[2])
  local limit=tonumber(ARGV[3])
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now-window)
  local wait=math.max(0,
    (tonumber(redis.call('GET', KEYS[2])) or 0)-now,
    (tonumber(redis.call('GET', KEYS[3])) or 0)-now)
  if redis.call('ZCARD', KEYS[1]) >= limit then
    local oldest=redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
    wait=math.max(wait, window-(now-tonumber(oldest[2])))
  end
  if wait > 0 then return wait end
  local interval=math.ceil(window/limit)
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], window)
  redis.call('SET', KEYS[2], now+interval, 'PX', interval)
  return 0`;

const COOLDOWN_SCRIPT = `
  local untilMs=math.max(tonumber(redis.call('GET', KEYS[1])) or 0,
    tonumber(ARGV[1])+tonumber(ARGV[2]))
  redis.call('SET', KEYS[1], untilMs, 'PX', untilMs-tonumber(ARGV[1]))
  return 0`;

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
  private localBlockedUntil = 0;

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
    for (;;) {
      const now = this.now();
      if (now >= deadlineMs) throw this.deadlineError();
      const wait = redis
        ? Number(
            await redis.eval(ACQUIRE_SCRIPT, {
              keys: [REQUESTS_KEY, PACING_KEY, COOLDOWN_KEY],
              arguments: [
                String(now),
                String(DISTRIBUTED_WINDOW_MS),
                String(limit),
                randomUUID()
              ]
            })
          )
        : Math.max(
            0,
            this.localNextRequestAt - now,
            this.localBlockedUntil - now
          );
      if (wait <= 0) {
        this.localNextRequestAt =
          now + Math.ceil(DISTRIBUTED_WINDOW_MS / limit);
        return;
      }
      if (this.now() + wait >= deadlineMs) throw this.deadlineError();
      await this.sleep(wait);
    }
  }

  async recordCooldown(delayMs: number): Promise<void> {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    const now = this.now();
    const duration = Math.ceil(delayMs);
    this.localBlockedUntil = Math.max(this.localBlockedUntil, now + duration);
    const redis = getRedisClient();
    if (redis) {
      await redis.eval(COOLDOWN_SCRIPT, {
        keys: [COOLDOWN_KEY],
        arguments: [String(now), String(duration)]
      });
    }
  }

  private deadlineError(): OpenSeaDeadlineError {
    return new OpenSeaDeadlineError(
      'OpenSea request deadline exceeded while rate limited'
    );
  }
}
