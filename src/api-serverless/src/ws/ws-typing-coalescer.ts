import { Logger } from '@/logging';
import { redisDeleteIfAvailable, redisSetIfAbsentForMillis } from '@/redis';

const logger = Logger.get('WS_TYPING_COALESCER');

/**
 * How long one identity's typing notification for a wave stands for any
 * further typing frames from that identity on that wave (all of its
 * connections). `WS_TYPING_COALESCE_MS`, default 3000.
 *
 * The web client sends a typing frame at most every four seconds per
 * composer and shows a typer for five seconds after the last notification,
 * so a three second window never drops a notification the indicator needs:
 * it only absorbs repeats from extra tabs, devices or composers.
 */
export const WS_TYPING_COALESCE_MS_DEFAULT = 3_000;
const WS_TYPING_COALESCE_MS_MAX = 10_000;
const MEMORY_ENTRIES = 5_000;

export function wsTypingCoalesceMillis(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.WS_TYPING_COALESCE_MS?.trim();
  if (!raw) return WS_TYPING_COALESCE_MS_DEFAULT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    logger.warn(
      `Invalid WS_TYPING_COALESCE_MS=${JSON.stringify(raw)}; using ${WS_TYPING_COALESCE_MS_DEFAULT}`
    );
    return WS_TYPING_COALESCE_MS_DEFAULT;
  }
  return Math.min(value, WS_TYPING_COALESCE_MS_MAX);
}

export class WsTypingCoalescer {
  /** Fallback while Redis is unavailable: claim expiry by key. */
  private readonly local = new Map<string, number>();

  constructor(
    private readonly setIfAbsent: typeof redisSetIfAbsentForMillis = redisSetIfAbsentForMillis,
    private readonly remove: typeof redisDeleteIfAvailable = redisDeleteIfAvailable,
    private readonly now: () => number = Date.now,
    private readonly windowMillis: () => number = wsTypingCoalesceMillis
  ) {}

  private key(identityId: string, waveId: string): string {
    return `ws_typing:${waveId}:${identityId}`;
  }

  /**
   * True when this frame should be sent: no typing notification for this
   * identity and wave went out within the window. False when it is covered
   * by one that did.
   */
  async claim(identityId: string, waveId: string): Promise<boolean> {
    const windowMillis = this.windowMillis();
    if (windowMillis <= 0) return true;
    const key = this.key(identityId, waveId);
    const shared = await this.setIfAbsent(key, windowMillis);
    if (shared !== null) return shared;
    return this.claimLocally(key, windowMillis);
  }

  /** Frees the window after a frame that was not delivered. */
  async release(identityId: string, waveId: string): Promise<void> {
    const key = this.key(identityId, waveId);
    this.local.delete(key);
    await this.remove(key);
  }

  private claimLocally(key: string, windowMillis: number): boolean {
    const now = this.now();
    const expiresAt = this.local.get(key);
    if (expiresAt !== undefined && expiresAt > now) return false;
    this.local.delete(key);
    this.local.set(key, now + windowMillis);
    while (this.local.size > MEMORY_ENTRIES) {
      const oldest = this.local.keys().next().value;
      if (oldest === undefined) break;
      this.local.delete(oldest);
    }
    return true;
  }
}

export const wsTypingCoalescer = new WsTypingCoalescer();
