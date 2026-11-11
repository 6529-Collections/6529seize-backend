import { Logger } from '@/logging';
import { redisTakeTokens, RedisTokenBucket } from '@/redis';
import { WsMessageType } from './ws-message';

const logger = Logger.get('WS_FRAME_BUDGET');

/**
 * Inbound WebSocket frame budgets, per connection. Every `$default` frame
 * other than PING takes a token from the connection's frame bucket;
 * USER_IS_TYPING also takes one from a stricter typing bucket.
 *
 * Defaults, both read on use from the Lambda environment:
 * - frames: 30 burst, refilled at 5 per second
 *   (`WS_FRAME_BUDGET_BURST`, `WS_FRAME_BUDGET_PER_SECOND`). A client sends a
 *   handful of control frames when it connects, re-authenticates or opens a
 *   wave, so a person never comes near it.
 * - typing: 5 burst, refilled at 0.5 per second
 *   (`WS_TYPING_FRAME_BUDGET_BURST`, `WS_TYPING_FRAME_BUDGET_PER_SECOND`).
 *   The web client sends at most one typing frame per composer every four
 *   seconds.
 */
export interface FrameBudgetLimits {
  readonly burst: number;
  readonly perSecond: number;
}

export const WS_FRAME_BUDGET_DEFAULT: FrameBudgetLimits = {
  burst: 30,
  perSecond: 5
};
export const WS_TYPING_FRAME_BUDGET_DEFAULT: FrameBudgetLimits = {
  burst: 5,
  perSecond: 0.5
};

/** Upper bound of connections tracked in memory while Redis is unavailable. */
export const WS_FRAME_BUDGET_MEMORY_ENTRIES = 5_000;

const warned = new Set<string>();

function positiveNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) return value;
  if (!warned.has(`${name}=${raw}`)) {
    warned.add(`${name}=${raw}`);
    logger.warn(`Invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
  }
  return fallback;
}

export function wsFrameBudgetLimits(env: NodeJS.ProcessEnv = process.env): {
  frames: FrameBudgetLimits;
  typing: FrameBudgetLimits;
} {
  return {
    frames: {
      burst: positiveNumber(
        env,
        'WS_FRAME_BUDGET_BURST',
        WS_FRAME_BUDGET_DEFAULT.burst
      ),
      perSecond: positiveNumber(
        env,
        'WS_FRAME_BUDGET_PER_SECOND',
        WS_FRAME_BUDGET_DEFAULT.perSecond
      )
    },
    typing: {
      burst: positiveNumber(
        env,
        'WS_TYPING_FRAME_BUDGET_BURST',
        WS_TYPING_FRAME_BUDGET_DEFAULT.burst
      ),
      perSecond: positiveNumber(
        env,
        'WS_TYPING_FRAME_BUDGET_PER_SECOND',
        WS_TYPING_FRAME_BUDGET_DEFAULT.perSecond
      )
    }
  };
}

interface MemoryBucket {
  tokens: number;
  at: number;
}

/**
 * The fallback used while Redis is unavailable: the same buckets kept in
 * this container only, capped in size (the oldest entry is dropped first).
 */
export class InMemoryTokenBuckets {
  private readonly buckets = new Map<string, MemoryBucket>();

  constructor(private readonly maxEntries = WS_FRAME_BUDGET_MEMORY_ENTRIES) {}

  take(buckets: readonly RedisTokenBucket[], now: number): boolean {
    const states = buckets.map((bucket) => {
      const stored = this.buckets.get(bucket.key);
      const tokens = stored
        ? Math.min(
            bucket.capacity,
            stored.tokens +
              (Math.max(0, now - stored.at) * bucket.refillPerSecond) / 1000
          )
        : bucket.capacity;
      return { key: bucket.key, tokens };
    });
    const allowed = states.every((state) => state.tokens >= 1);
    for (const state of states) {
      this.buckets.delete(state.key);
      this.buckets.set(state.key, {
        tokens: allowed ? state.tokens - 1 : state.tokens,
        at: now
      });
    }
    while (this.buckets.size > this.maxEntries) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return allowed;
  }

  get size(): number {
    return this.buckets.size;
  }
}

export type FrameBudgetDecision = 'allowed' | 'rejected';

export class WsFrameBudget {
  private lastFallbackWarningAt: number | null = null;

  constructor(
    private readonly takeShared: typeof redisTakeTokens = redisTakeTokens,
    private readonly local = new InMemoryTokenBuckets(),
    private readonly now: () => number = Date.now,
    private readonly limits: () => ReturnType<
      typeof wsFrameBudgetLimits
    > = wsFrameBudgetLimits
  ) {}

  /** Takes this frame's tokens; PING frames are never counted. */
  async take(
    connectionId: string,
    frameType: string | null
  ): Promise<FrameBudgetDecision> {
    const { frames, typing } = this.limits();
    // One hash tag per connection keeps both buckets in one cluster slot.
    const tag = `{ws_frames:${connectionId}}`;
    const buckets: RedisTokenBucket[] = [
      {
        key: `${tag}:all`,
        capacity: frames.burst,
        refillPerSecond: frames.perSecond
      }
    ];
    if (frameType === WsMessageType.USER_IS_TYPING) {
      buckets.push({
        key: `${tag}:typing`,
        capacity: typing.burst,
        refillPerSecond: typing.perSecond
      });
    }
    const now = this.now();
    // Long enough for the slowest bucket to refill completely.
    const ttlMillis = Math.max(
      ...buckets.map(
        (bucket) => (bucket.capacity / bucket.refillPerSecond) * 1000
      )
    );
    let shared: boolean | null = null;
    try {
      shared = await this.takeShared(buckets, now, ttlMillis);
    } catch {
      this.warnFallback(now);
    }
    const allowed = shared ?? this.local.take(buckets, now);
    return allowed ? 'allowed' : 'rejected';
  }

  private warnFallback(now: number) {
    if (
      this.lastFallbackWarningAt !== null &&
      now - this.lastFallbackWarningAt < 60_000
    )
      return;
    this.lastFallbackWarningAt = now;
    logger.warn('ws_frame_budget_local_fallback');
  }
}

export const wsFrameBudget = new WsFrameBudget();
