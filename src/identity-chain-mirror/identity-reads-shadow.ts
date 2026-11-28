import { appFeatures } from '@/app-features';
import { chainGatewayHeadTtlMs } from '@/chain-gateway/chain-gateway.client';
import { loggerContext } from '@/logger-context';
import { Logger } from '@/logging';
import { isPlaceholderHandle } from './identity-plan';

const logger = Logger.get('IDENTITY_READS_SHADOW');

/** The identity lookups that read the chain with the flag on. */
export type IdentityLookupKind =
  | 'login'
  | 'by_wallet'
  | 'by_handle'
  | 'by_profile_id'
  | 'availability';

const KINDS: readonly IdentityLookupKind[] = [
  'login',
  'by_wallet',
  'by_handle',
  'by_profile_id',
  'availability'
];

/** One line per minute: the counts are of one calendar minute. */
const WINDOW_MS = 60_000;

/** The (kind, key) pairs kept for one head window; cleared past this. */
export const SHADOW_MAX_KEYS = 10_000;

function emptyCounts(): Record<IdentityLookupKind, number> {
  return {
    login: 0,
    by_wallet: 0,
    by_handle: 0,
    by_profile_id: 0,
    availability: 0
  };
}

/**
 * What the identity lookups would ask the chain gateway on this instance,
 * flag on or off, counted in memory only: no gateway call, no database
 * read, O(1) a lookup. Each of the five call sites notes (kind, key) on
 * every lookup. A lookup is a would-send when its (kind, key) wasn't seen
 * in the current head window (floor(now / CHAIN_GATEWAY_HEAD_TTL_MS)), as
 * the gateway client answers a repeat within the window from its cache; a
 * placeholder handle (`id-0x...`) counts two (its handle, then its owner).
 * Each head window with any would-send adds one head read, which
 * would_send includes. The keys are cleared when the window moves on, or
 * past SHADOW_MAX_KEYS (counting high after that, never low).
 *
 * With no timers (a Lambda instance is frozen between requests), the
 * minute's line is written by the first note, fallback or 503 after the
 * minute ends, `window_start` naming the minute the counts are of:
 *
 *   [IDENTITY READS SHADOW] window_start=2026-11-28T10:41:00.000Z window_s=60
 *   flag=off login=12 by_wallet=3 by_handle=40 by_profile_id=7
 *   availability=1 would_send=55 head_reads=4 head_ttl_ms=2000
 *   mirror_fallbacks=0 mirror_503=0
 *
 * (one line, written outside any request's log context). An instance's
 * last minute before it is shut down is never written. mirror_fallbacks and
 * mirror_503 come from ChainIdentityReads. A failure here never fails the
 * lookup: it is logged once and the count goes on.
 */
export class IdentityReadsShadow {
  private minute: number | null = null;
  private counts = emptyCounts();
  private wouldSend = 0;
  private headReads = 0;
  private fallbacks = 0;
  private refused = 0;
  private headWindow: number | null = null;
  private headWindowRead = false;
  private readonly seen = new Set<string>();
  private headTtl: number | null = null;
  private failedOnce = false;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly headTtlMs: () => number = () => chainGatewayHeadTtlMs(),
    private readonly flagOn: () => boolean = () =>
      appFeatures.isIdentityReadsFromChainEnabled()
  ) {}

  /** A lookup of `kind` by `key` (a wallet, handle or profile id). */
  note(kind: IdentityLookupKind, key: string): void {
    this.safely(() => this.count(kind, key));
  }

  /** A lookup answered from the mirror's tables (the gateway couldn't). */
  mirrorFallback(): void {
    this.safely(() => {
      this.roll(this.now());
      this.fallbacks++;
    });
  }

  /** A lookup refused with 503 (no fallback, or the mirror isn't fresh). */
  mirror503(): void {
    this.safely(() => {
      this.roll(this.now());
      this.refused++;
    });
  }

  private safely(step: () => void) {
    try {
      step();
    } catch (error) {
      if (this.failedOnce) return;
      this.failedOnce = true;
      logger.warn(
        `[IDENTITY READS SHADOW FAILED] [${(error as Error)?.message ?? error}] [LOGGED ONCE AN INSTANCE]`
      );
    }
  }

  private count(kind: IdentityLookupKind, key: string) {
    const now = this.now();
    this.roll(now);
    this.counts[kind]++;
    const ttl = this.ttl();
    const headWindow = Math.floor(now / ttl);
    if (headWindow !== this.headWindow) {
      this.headWindow = headWindow;
      this.headWindowRead = false;
      this.seen.clear();
    }
    const seenKey = `${kind} ${key.toLowerCase()}`;
    if (this.seen.has(seenKey)) return;
    if (this.seen.size >= SHADOW_MAX_KEYS) this.seen.clear();
    this.seen.add(seenKey);
    this.wouldSend +=
      kind === 'by_handle' && isPlaceholderHandle(key.toLowerCase()) ? 2 : 1;
    if (!this.headWindowRead) {
      this.headWindowRead = true;
      this.headReads++;
      this.wouldSend++;
    }
  }

  private ttl(): number {
    if (this.headTtl === null) {
      // 0 would make every lookup its own window.
      this.headTtl = Math.max(1, this.headTtlMs());
    }
    return this.headTtl;
  }

  /** Past the minute the counts are of: its line, then a fresh minute. */
  private roll(now: number) {
    const minute = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    if (this.minute === null) {
      this.minute = minute;
      return;
    }
    if (minute === this.minute) return;
    const line = this.lineOf(this.minute);
    this.minute = minute;
    this.counts = emptyCounts();
    this.wouldSend = 0;
    this.headReads = 0;
    this.fallbacks = 0;
    this.refused = 0;
    // Outside the request that happens to write it: the line is the
    // instance's, so it carries no request id or token subject.
    loggerContext.run({}, () => logger.info(line));
  }

  private lineOf(minute: number): string {
    const counts = KINDS.map((kind) => `${kind}=${this.counts[kind]}`).join(
      ' '
    );
    return `[IDENTITY READS SHADOW] window_start=${new Date(minute).toISOString()} window_s=${WINDOW_MS / 1000} flag=${this.flag()} ${counts} would_send=${this.wouldSend} head_reads=${this.headReads} head_ttl_ms=${this.ttl()} mirror_fallbacks=${this.fallbacks} mirror_503=${this.refused}`;
  }

  private flag(): 'on' | 'off' | 'unknown' {
    try {
      return this.flagOn() ? 'on' : 'off';
    } catch {
      return 'unknown';
    }
  }
}

/** This instance's counter. */
export const identityReadsShadow = new IdentityReadsShadow();
