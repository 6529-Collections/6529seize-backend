import { randomUUID } from 'node:crypto';
import { env } from '@/env';
import { Logger } from '@/logging';
import { getRedisClient } from '@/redis';
import { Time } from '@/time';

/**
 * Per-drop coalescing of the reaction and rating broadcasts (waves plan 1.6).
 *
 * Every reaction or vote request used to fan the whole drop out to the wave
 * audience on its own. A burst on one drop therefore sent the same drop many
 * times. Requests run in separate Lambda invocations, so the window lives in
 * Redis:
 *
 * - The first update in a quiet period broadcasts at once (`leading`) and
 *   opens a window.
 * - The first update inside an open window becomes the single trailing
 *   flusher. It waits until the window closes, then broadcasts the drop's
 *   state as of that moment (`trailing`) and opens the next window.
 * - Any further update inside the window, or one that opens a new window
 *   while a trailing flusher is still pending, returns at once
 *   (`coalesced`): its write has already committed, and the pending flusher
 *   reads the state after it.
 *
 * The flusher releases its claim before it reads the state, so an update that
 * commits after the read starts a new flush instead of being dropped. If
 * Redis is unavailable the broadcast goes out at once, as before.
 */

export type DropBroadcastKind = 'REACTION' | 'RATING';

/** How the caller's update reached the audience. */
export type DropBroadcastPhase = 'leading' | 'trailing' | 'immediate';

export type DropBroadcastOutcome = DropBroadcastPhase | 'coalesced';

export interface DropBroadcastLeaseStore {
  /**
   * Claims `key` for `ttlMs`. Resolves true when claimed, false when another
   * invocation holds it, and null when the store is unavailable.
   */
  acquire(key: string, token: string, ttlMs: number): Promise<boolean | null>;
  /** Whether `key` is held: null when the store is unavailable. */
  isHeld(key: string): Promise<boolean | null>;
  /** Milliseconds until `key` expires: 0 when it is gone, null when unknown. */
  remainingMs(key: string): Promise<number | null>;
  /** Deletes `key` only while `token` still owns it. Never throws. */
  release(key: string, token: string): Promise<void>;
}

export const DROP_BROADCAST_COALESCE_ENV = 'WS_DROP_UPDATE_COALESCE_MS';
/**
 * Coalescing changes when frames reach viewers, so it ships off: an unset
 * value means 0. Staging sets 250 (the plan's window); production stays off
 * until the owner turns it on.
 */
export const DEFAULT_DROP_BROADCAST_COALESCE_MS = 0;
const MAX_DROP_BROADCAST_COALESCE_MS = 2_000;
const REDIS_COMMAND_TIMEOUT_MS = 100;
const KEY_PREFIX = 'ws_coalesce_6529';

export function readDropBroadcastCoalesceWindowMs(): number {
  const configured = env.getIntOrNull(DROP_BROADCAST_COALESCE_ENV);
  if (configured === null || !Number.isFinite(configured)) {
    return DEFAULT_DROP_BROADCAST_COALESCE_MS;
  }
  return Math.min(Math.max(configured, 0), MAX_DROP_BROADCAST_COALESCE_MS);
}

/**
 * One EMF count per broadcast, so a Redis outage that silently turns every
 * broadcast into `immediate` is visible. Fixed, low-cardinality dimensions.
 */
function recordOutcome(
  kind: DropBroadcastKind,
  outcome: DropBroadcastOutcome
): void {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;
  const environment = (process.env.SENTRY_ENVIRONMENT ?? '').includes('staging')
    ? 'staging'
    : 'prod';
  try {
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: '6529/WaveBroadcast',
              Dimensions: [['Environment', 'Kind', 'Outcome']],
              Metrics: [{ Name: 'DropBroadcastCoalesce', Unit: 'Count' }]
            }
          ]
        },
        Environment: environment,
        Kind: kind,
        Outcome: outcome,
        DropBroadcastCoalesce: 1
      })}
`
    );
  } catch {
    /* Telemetry must not alter delivery. */
  }
}

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Redis coalescing command timed out')),
      REDIS_COMMAND_TIMEOUT_MS
    );
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

export class RedisDropBroadcastLeaseStore implements DropBroadcastLeaseStore {
  private readonly logger = Logger.get(this.constructor.name);

  private client() {
    const client = getRedisClient();
    return client?.isReady ? client : null;
  }

  async acquire(
    key: string,
    token: string,
    ttlMs: number
  ): Promise<boolean | null> {
    const client = this.client();
    if (!client) return null;
    try {
      const result = await withTimeout(
        client.set(key, token, { NX: true, PX: ttlMs })
      );
      return result !== null;
    } catch (error) {
      this.logger.warn(
        `Drop broadcast coalescing unavailable, sending at once: ${String(
          error
        )}`
      );
      return null;
    }
  }

  async isHeld(key: string): Promise<boolean | null> {
    const client = this.client();
    if (!client) return null;
    try {
      return (await withTimeout(client.exists(key))) > 0;
    } catch {
      return null;
    }
  }

  async remainingMs(key: string): Promise<number | null> {
    const client = this.client();
    if (!client) return null;
    try {
      const ttl = await withTimeout(client.pTTL(key));
      if (ttl === -2) return 0;
      return ttl >= 0 ? ttl : null;
    } catch {
      return null;
    }
  }

  async release(key: string, token: string): Promise<void> {
    const client = this.client();
    if (!client) return;
    try {
      await withTimeout(
        client.eval(
          `if redis.call('GET', KEYS[1]) == ARGV[1] then
             return redis.call('DEL', KEYS[1])
           end
           return 0`,
          { keys: [key], arguments: [token] }
        )
      );
    } catch {
      // The claim expires on its own; a failed release only delays the next flush.
    }
  }
}

export class DropBroadcastCoalescer {
  constructor(
    private readonly store: DropBroadcastLeaseStore,
    private readonly windowMs: () => number = readDropBroadcastCoalesceWindowMs,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      Time.millis(ms).sleep()
  ) {}

  /**
   * Call after the update has committed. `send` broadcasts the drop; in the
   * `trailing` phase it must load the drop's current state itself, because
   * other invocations' updates landed after the caller's own read.
   */
  async broadcast({
    kind,
    dropId,
    send
  }: {
    kind: DropBroadcastKind;
    dropId: string;
    send: (phase: DropBroadcastPhase) => Promise<void>;
  }): Promise<DropBroadcastOutcome> {
    const outcome = await this.coalesce({ kind, dropId, send });
    recordOutcome(kind, outcome);
    return outcome;
  }

  private async coalesce({
    kind,
    dropId,
    send
  }: {
    kind: DropBroadcastKind;
    dropId: string;
    send: (phase: DropBroadcastPhase) => Promise<void>;
  }): Promise<DropBroadcastOutcome> {
    const windowMs = this.windowMs();
    if (windowMs <= 0) {
      await send('immediate');
      return 'immediate';
    }
    const token = randomUUID();
    const leadKey = `${KEY_PREFIX}:${kind}:${dropId}:lead`;
    const lead = await this.store.acquire(leadKey, token, windowMs);
    if (lead === null) {
      await send('immediate');
      return 'immediate';
    }
    const trailKey = `${KEY_PREFIX}:${kind}:${dropId}:trail`;
    if (lead) {
      // A window can close while its trailing flusher is still waking up.
      // That flusher reads after releasing its claim, so it covers this
      // update too; sending here as well would double the boundary send.
      if ((await this.store.isHeld(trailKey)) === true) {
        return 'coalesced';
      }
      await send('leading');
      return 'leading';
    }
    // The trail claim outlives one wait so a stalled flusher cannot pin it.
    const trail = await this.store.acquire(trailKey, token, windowMs * 3);
    if (trail === null) {
      await send('immediate');
      return 'immediate';
    }
    if (!trail) {
      return 'coalesced';
    }
    try {
      const remaining = await this.store.remainingMs(leadKey);
      const waitMs =
        remaining === null ? windowMs : Math.min(remaining, windowMs);
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }
    } finally {
      // Release before reading state: an update committing after this point
      // either leads a new window or becomes the next trailing flusher.
      await this.store.release(trailKey, token);
    }
    // Throttle a sustained burst to one broadcast per window. The result is
    // ignored on purpose: if another update opened the window in the gap, it
    // has already sent, or deferred to a flusher that reads after it.
    // Updates that commit after the release either lead a window or become
    // the next trailing flusher, so none is folded into this send's read.
    await this.store.acquire(leadKey, token, windowMs);
    await send('trailing');
    return 'trailing';
  }
}

export const dropBroadcastCoalescer = new DropBroadcastCoalescer(
  new RedisDropBroadcastLeaseStore()
);
