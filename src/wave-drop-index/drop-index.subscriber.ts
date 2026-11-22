import { DeviceEventKind } from '@/api/device-signing/device-event';
import { DeviceGrantEntity } from '@/entities/IDeviceGrant';
import {
  CrpAuthAnswer,
  CrpAuthed,
  CrpChallenge,
  CrpCursor,
  CrpHistoryPage,
  CrpItem,
  CrpSubscriptionHandlers,
  CrpWelcome
} from '@/wave-relay-publish/crp-client';
import { IngestedEvent, IngestRow, RejectRow } from './drop-index.db';
import {
  checkRelayEvent,
  GrantCheckCache,
  readRelayEvent
} from './relay-event-check';
import { isSameRelayWave, relayWaveKey } from './relay-wave-key';

/**
 * Reads the 6529 relays into 6529.io's drop index: one connection a relay,
 * subscriptions from the index's cursors, each event checked as every
 * reader checks it, stored once with the cursors it moves in one
 * transaction, then handed to the index's listeners.
 *
 * - Up to MAX_SINCE known waves: one subscription to every wave (`*`) with
 *   their cursors, waves without one replayed from their start. More: the
 *   known waves in subscriptions of SUB_WAVES each (the relay takes at most
 *   500 waves a subscription, and a frame stays under its 128 KiB), and `*`
 *   for live events only; a wave first seen there is paged with HIST from
 *   its start.
 * - Before a wave's replay ends (EOSE), its cursor moves only through
 *   events that follow it without a gap; a live event that comes ahead of
 *   the replay waits for the EOSE, so a run cut short never leaves a cursor
 *   past events it hasn't read.
 * - A wave whose cursor the relay can no longer replay (RESYNC) is paged
 *   with HIST from its cursor when the relay's log epoch is the cursor's,
 *   else from the start. Its live events wait for the paging, so its
 *   cursor never passes events not read yet.
 * - A relay names a wave as its subscriber did; under `*`, by its key (a
 *   6529.io wave UUID's derived chain id), while the event keeps the name
 *   its author signed.
 * - A copy that fails a check goes to wave_relay_rejects with why, so a fix
 *   can check it again; the cursor moves past it. The first valid copy of
 *   an event is the one stored, whichever relay sent a bad copy first.
 * - An event claimed before switch-on (the run's liveFrom) is stored as
 *   history, event_origin IMPORT, so writing it sends no notifications;
 *   later ones as OPERATION.
 */

/** What the subscriber needs of a CRP connection. */
export interface DropIndexConnection {
  readonly welcomeInfo: CrpWelcome;
  subscribe(
    sid: number,
    waves: string[],
    since: CrpCursor[],
    fromStart: boolean,
    handlers: CrpSubscriptionHandlers
  ): void;
  history(
    wave: string,
    after: number | null,
    limit: number,
    timeoutMs?: number
  ): Promise<CrpHistoryPage>;
  authenticate(
    answer: (challenge: CrpChallenge, welcome: CrpWelcome) => CrpAuthAnswer
  ): Promise<CrpAuthed>;
  close(): void;
}

/** What the subscriber needs of the index's tables. */
export interface DropIndexStore {
  cursors(relayId: string): Promise<CrpCursor[]>;
  knownGrants(ids: readonly string[]): Promise<Map<string, DeviceGrantEntity>>;
  siteEvents(eventIds: readonly string[]): Promise<Map<string, string | null>>;
  ingest(
    rows: readonly IngestRow[],
    rejects: readonly RejectRow[],
    relayId: string,
    cursors: readonly CrpCursor[],
    now: number
  ): Promise<IngestedEvent[]>;
}

/** Called after each stored batch, in the index's order. */
export type DropIndexListener = (
  events: readonly IngestedEvent[]
) => Promise<void> | void;

export interface DropIndexRunOptions {
  readonly relays: readonly string[];
  readonly budgetMs: number;
  /** A relay that sends nothing for this long is done for the run. */
  readonly quietMs: number;
  /** How often what arrived is checked and stored. */
  readonly flushMs: number;
  /** Events a HIST page asks for (the relay sends at most 500). */
  readonly pageSize: number;
  /** Arrivals held in memory at most (default MAX_HELD). */
  readonly maxHeld?: number;
  /**
   * Switch-on (ms): an event claimed before it is history, stored with
   * event_origin IMPORT; from it on, OPERATION.
   */
  readonly liveFrom: number;
}

export interface RelayIngestReport {
  readonly relay: string;
  relayId: string | null;
  received: number;
  stored: number;
  held: number;
  /**
   * Events not stored this run (past the deadline or past MAX_HELD); the
   * cursors stay before them, so the next run reads them again.
   */
  left: number;
  rejected: number;
  reasons: Record<string, number>;
  resyncs: number;
  readsMembersOnly: boolean;
  authError: string | null;
  error: string | null;
}

/** Cursors one `*` SUB frame carries, so it stays under 128 KiB. */
export const MAX_SINCE = 800;
/** Waves one explicit SUB names (the relay takes at most 500). */
export const SUB_WAVES = 450;
/** Arrivals checked and stored at once. */
const STORE_BATCH = 500;
/**
 * Arrivals a run holds in memory at most. Past it, the run takes nothing
 * more from the relay, stores what it holds and ends; every cursor stays
 * before what it didn't take.
 */
export const MAX_HELD = 10 * STORE_BATCH;
const ALL_SID = 1;
/** The wave ids the index's tables hold. */
const MAX_WAVE_CHARS = 255;

/**
 * A relay-only post's drop id: its event id's first 16 bytes as a UUID,
 * the id 6529.io writes it under, so a rebuild gives the same id.
 */
export function dropIdOfEvent(eventId: string): string {
  const h = eventId.slice(2, 34).toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

interface Arrival {
  readonly wave: string;
  readonly logEpoch: number;
  readonly item: CrpItem;
}

export class DropIndexSubscriber {
  constructor(
    private readonly store: DropIndexStore,
    private readonly open: (relay: string) => Promise<DropIndexConnection>,
    private readonly listeners: () => readonly DropIndexListener[],
    private readonly log: (message: string) => void,
    private readonly reader:
      | ((challenge: CrpChallenge, welcome: CrpWelcome) => CrpAuthAnswer)
      | null = null,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  async run(options: DropIndexRunOptions): Promise<RelayIngestReport[]> {
    const deadline = this.now() + options.budgetMs;
    const reports: RelayIngestReport[] = [];
    const grantChecks: GrantCheckCache = new Map();
    for (const relay of options.relays) {
      if (this.now() >= deadline) break;
      // Each relay gets an even share of what is left.
      const left = deadline - this.now();
      const share = left / (options.relays.length - reports.length);
      reports.push(
        await this.readRelay(relay, this.now() + share, options, grantChecks)
      );
    }
    return reports;
  }

  private async readRelay(
    relay: string,
    deadline: number,
    options: DropIndexRunOptions,
    grantChecks: GrantCheckCache
  ): Promise<RelayIngestReport> {
    const report: RelayIngestReport = {
      relay,
      relayId: null,
      received: 0,
      stored: 0,
      held: 0,
      left: 0,
      rejected: 0,
      reasons: {},
      resyncs: 0,
      readsMembersOnly: false,
      authError: null,
      error: null
    };
    let connection: DropIndexConnection | null = null;
    const arrivals: Arrival[] = [];
    let relayId = '';
    try {
      connection = await this.open(relay);
      relayId = connection.welcomeInfo.relayId;
      report.relayId = relayId;
      if (this.reader) {
        try {
          const authed = await connection.authenticate(this.reader);
          report.readsMembersOnly = authed.roles.includes('site-reader');
        } catch (error) {
          // Open waves are still read.
          report.authError =
            error instanceof Error ? error.message : String(error);
          this.log(`[DROP INDEX] ${relay}: AUTH failed: ${report.authError}`);
        }
      }
      const cursors = await this.store.cursors(relayId);
      const known = new Map(cursors.map((c) => [c.wave, c]));
      const toPage = new Map<string, number>();
      const paging = new Set<string>();
      let lastFrameAt = this.now();
      const relayEpoch = connection.welcomeInfo.logEpoch;
      // Before a wave's EOSE: the rseq its events follow without a gap, and
      // the events that came ahead of it.
      const contiguous = new Map<string, number>(
        cursors.map((c) => [c.wave, c.logEpoch === relayEpoch ? c.rseq : 0])
      );
      const ahead = new Map<string, Arrival[]>();
      let aheadCount = 0;
      let full = false;
      const replayed = new Set<string>();
      // Once full, nothing more is taken this run: what was taken is, per
      // wave, a run of its log from the cursor, so cursors stay exact.
      const maxHeld = options.maxHeld ?? MAX_HELD;
      const handlers = (live: boolean): CrpSubscriptionHandlers => ({
        onEvent: (wave, logEpoch, item) => {
          lastFrameAt = this.now();
          if (paging.has(wave) || toPage.has(wave)) return;
          if (live && !known.has(wave)) {
            // A wave first seen live: read it from its start.
            toPage.set(wave, 0);
            return;
          }
          if (full || arrivals.length + aheadCount >= maxHeld) {
            full = true;
            report.left++;
            return;
          }
          const arrival = { wave, logEpoch, item };
          if (replayed.has(wave)) {
            arrivals.push(arrival);
            return;
          }
          const at = contiguous.get(wave) ?? 0;
          if (item.rseq <= at + 1) {
            contiguous.set(wave, Math.max(at, item.rseq));
            arrivals.push(arrival);
          } else {
            ahead.set(wave, [...(ahead.get(wave) ?? []), arrival]);
            aheadCount++;
          }
        },
        onEose: (wave) => {
          lastFrameAt = this.now();
          const held = ahead.get(wave) ?? [];
          ahead.delete(wave);
          aheadCount -= held.length;
          if (full) {
            // Replay events between the cursor and these may have been
            // passed over: storing these would skip them.
            report.left += held.length;
            return;
          }
          replayed.add(wave);
          arrivals.push(...held);
        },
        onResync: (wave) => {
          lastFrameAt = this.now();
          const cursor = known.get(wave);
          toPage.set(
            wave,
            cursor && cursor.logEpoch === relayEpoch ? cursor.rseq : 0
          );
        }
      });
      if (cursors.length <= MAX_SINCE) {
        connection.subscribe(ALL_SID, ['*'], cursors, true, handlers(false));
      } else {
        for (let i = 0; i < cursors.length; i += SUB_WAVES) {
          const chunk = cursors.slice(i, i + SUB_WAVES);
          connection.subscribe(
            ALL_SID + 1 + i / SUB_WAVES,
            chunk.map((c) => c.wave),
            chunk,
            false,
            handlers(false)
          );
        }
        connection.subscribe(ALL_SID, ['*'], [], false, handlers(true));
      }
      while (this.now() < deadline) {
        await this.sleep(options.flushMs);
        while (arrivals.length && this.now() < deadline) {
          await this.store_(
            relayId,
            arrivals.splice(0, STORE_BATCH),
            report,
            grantChecks,
            options.liveFrom
          );
        }
        for (const [wave, after] of Array.from(toPage.entries())) {
          if (this.now() >= deadline) break;
          toPage.delete(wave);
          paging.add(wave);
          report.resyncs++;
          const reached = await this.pageWave(
            connection,
            relayId,
            wave,
            after,
            deadline,
            options,
            report,
            grantChecks
          );
          // Its live events stay passed over for the rest of the run: one
          // stored after the pages would move its cursor past those that
          // came while paging. The next run resumes from `reached`.
          known.set(wave, { wave, logEpoch: relayEpoch, rseq: reached });
        }
        if (
          !arrivals.length &&
          !toPage.size &&
          (full || this.now() - lastFrameAt >= options.quietMs)
        ) {
          break;
        }
      }
      report.left += aheadCount;
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      this.log(`[DROP INDEX] ${relay}: ${report.error}`);
    } finally {
      connection?.close();
    }
    // What came after the last store waits for the next run, which reads it
    // again from the cursors (they stay before it).
    report.left += arrivals.splice(0).length;
    return report;
  }

  /**
   * A wave's log after `after`, page by page, to the deadline. Returns the
   * rseq it reached.
   */
  private async pageWave(
    connection: DropIndexConnection,
    relayId: string,
    wave: string,
    after: number,
    deadline: number,
    options: DropIndexRunOptions,
    report: RelayIngestReport,
    grantChecks: GrantCheckCache
  ): Promise<number> {
    let cursor = after;
    while (this.now() < deadline) {
      const page = await connection.history(
        wave,
        cursor,
        options.pageSize,
        Math.max(1, deadline - this.now())
      );
      if (!page.items.length) return cursor;
      await this.store_(
        relayId,
        page.items.map((item) => ({ wave, logEpoch: page.logEpoch, item })),
        report,
        grantChecks,
        options.liveFrom
      );
      cursor = page.items[page.items.length - 1].rseq;
      if (!page.more) return cursor;
    }
    return cursor;
  }

  /**
   * Checks what arrived and stores it with the cursors it moves. An event
   * that fails a check is stored as rejected (when its id can be read) and
   * moves its cursor too.
   */
  private async store_(
    relayId: string,
    arrivals: readonly Arrival[],
    report: RelayIngestReport,
    grantChecks: GrantCheckCache,
    liveFrom: number
  ): Promise<void> {
    report.received += arrivals.length;
    const eventIds = arrivals.map((a) =>
      String(a.item.event.id ?? '').toLowerCase()
    );
    const grantIds = arrivals.map((a) =>
      String(a.item.grant.id ?? '').toLowerCase()
    );
    const [known, site] = await Promise.all([
      this.store.knownGrants(grantIds.filter(Boolean)),
      this.store.siteEvents(eventIds.filter(Boolean))
    ]);
    const now = this.now();
    const rows: IngestRow[] = [];
    const rejects: RejectRow[] = [];
    const seen = new Set<string>();
    for (const { wave, item } of arrivals) {
      const authRef = String(item.event.auth_ref ?? '').toLowerCase();
      const knownGrant = known.get(authRef) ?? null;
      const check = checkRelayEvent(
        item.event,
        item.grant,
        knownGrant,
        grantChecks
      );
      const reason = !check.ok
        ? check.reason
        : !isSameRelayWave(wave, check.event.wave)
          ? 'event of another wave'
          : check.event.wave.length > MAX_WAVE_CHARS
            ? 'wave id too long'
            : null;
      if (!check.ok || reason) {
        const why = reason ?? 'rejected';
        report.rejected++;
        report.reasons[why] = (report.reasons[why] ?? 0) + 1;
        const readable = readRelayEvent(item.event);
        rejects.push({
          event_id: typeof readable === 'string' ? null : readable.id,
          relay_id: relayId,
          wave: wave.slice(0, MAX_WAVE_CHARS),
          reason: why.slice(0, 255),
          event: item.event,
          grant_proof: item.grant,
          received_at: now
        });
        continue;
      }
      const { event, grant } = check;
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      const isSite = site.has(event.id);
      const revokedAt = [grant.revokedAt, knownGrant?.revoked_at ?? null]
        .filter((at): at is number => at !== null && at !== undefined)
        .map(Number);
      rows.push({
        event_id: event.id,
        relay_id: relayId,
        wave: event.wave,
        wave_key: relayWaveKey(event.wave),
        drop_id:
          event.kind === DeviceEventKind.POST
            ? isSite
              ? (site.get(event.id) ?? null)
              : dropIdOfEvent(event.id)
            : (event.refs[0] ?? null),
        kind: event.kind,
        author: event.author,
        device_key: event.deviceKey,
        auth_ref: event.authRef,
        seq: event.seq,
        claimed_time: event.claimedTime,
        event: item.event,
        grant_proof: item.grant,
        origin: isSite ? 'site' : 'relay',
        event_origin: event.claimedTime < liveFrom ? 'IMPORT' : 'OPERATION',
        status: 'logged',
        status_reason: null,
        grant_check: check.grantVia,
        grant_revoked_at: revokedAt.length ? Math.min(...revokedAt) : null,
        received_at: now
      });
    }
    const cursors = new Map<string, CrpCursor>();
    for (const { wave, logEpoch, item } of arrivals) {
      const at = cursors.get(wave);
      if (!at || at.logEpoch !== logEpoch || item.rseq > at.rseq) {
        cursors.set(wave, { wave, logEpoch, rseq: item.rseq });
      }
    }
    const stored = await this.store.ingest(
      rows,
      rejects,
      relayId,
      Array.from(cursors.values()).filter(
        (c) => c.wave.length <= MAX_WAVE_CHARS
      ),
      now
    );
    report.stored += stored.length;
    report.held += rows.length - stored.length;
    if (!stored.length) return;
    for (const listener of this.listeners()) {
      try {
        await listener(stored);
      } catch (error) {
        this.log(`[DROP INDEX LISTENER FAILED] ${error}`);
      }
    }
  }
}
