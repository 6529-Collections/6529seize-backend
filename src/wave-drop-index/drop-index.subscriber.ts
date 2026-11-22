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
import { IngestedEvent, IngestRow } from './drop-index.db';
import { checkRelayEvent } from './relay-event-check';

/**
 * Reads the 6529 relays into 6529.io's drop index: one connection a relay,
 * a subscription to every wave it carries (`*`) from the index's cursors,
 * each event checked as every reader checks it, stored once, its cursor
 * moved in the same transaction, then handed to the index's listeners. A
 * wave whose cursor the relay can no longer replay (RESYNC) is paged with
 * HIST from its start; events already held are passed over.
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
    limit: number
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
}

export interface RelayIngestReport {
  readonly relay: string;
  relayId: string | null;
  received: number;
  stored: number;
  held: number;
  rejected: number;
  reasons: Record<string, number>;
  resyncs: number;
  readsMembersOnly: boolean;
  error: string | null;
}

const HIST_SID = 1;
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
    for (const relay of options.relays) {
      if (this.now() >= deadline) break;
      // Each relay gets an even share of what is left.
      const left = deadline - this.now();
      const share = left / (options.relays.length - reports.length);
      reports.push(await this.readRelay(relay, this.now() + share, options));
    }
    return reports;
  }

  private async readRelay(
    relay: string,
    deadline: number,
    options: DropIndexRunOptions
  ): Promise<RelayIngestReport> {
    const report: RelayIngestReport = {
      relay,
      relayId: null,
      received: 0,
      stored: 0,
      held: 0,
      rejected: 0,
      reasons: {},
      resyncs: 0,
      readsMembersOnly: false,
      error: null
    };
    let connection: DropIndexConnection | null = null;
    try {
      connection = await this.open(relay);
      const relayId = connection.welcomeInfo.relayId;
      report.relayId = relayId;
      if (this.reader) {
        const authed = await connection.authenticate(this.reader);
        report.readsMembersOnly = authed.roles.includes('site-reader');
      }
      const arrivals: Arrival[] = [];
      const resync = new Set<string>();
      let lastFrameAt = this.now();
      connection.subscribe(
        HIST_SID,
        ['*'],
        await this.store.cursors(relayId),
        true,
        {
          onEvent: (wave, logEpoch, item) => {
            arrivals.push({ wave, logEpoch, item });
            lastFrameAt = this.now();
          },
          onEose: () => {
            lastFrameAt = this.now();
          },
          onResync: (wave) => {
            resync.add(wave);
            lastFrameAt = this.now();
          }
        }
      );
      while (this.now() < deadline) {
        await this.sleep(options.flushMs);
        if (arrivals.length) {
          await this.store_(relayId, arrivals.splice(0), report);
        }
        for (const wave of Array.from(resync)) {
          resync.delete(wave);
          report.resyncs++;
          await this.pageWave(
            connection,
            relayId,
            wave,
            deadline,
            options,
            report
          );
        }
        if (
          !arrivals.length &&
          !resync.size &&
          this.now() - lastFrameAt >= options.quietMs
        ) {
          break;
        }
      }
      if (arrivals.length) {
        await this.store_(relayId, arrivals.splice(0), report);
      }
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      this.log(`[DROP INDEX] ${relay}: ${report.error}`);
    } finally {
      connection?.close();
    }
    return report;
  }

  /** A wave's log from its start in the relay's current epoch. */
  private async pageWave(
    connection: DropIndexConnection,
    relayId: string,
    wave: string,
    deadline: number,
    options: DropIndexRunOptions,
    report: RelayIngestReport
  ): Promise<void> {
    let after = 0;
    while (this.now() < deadline) {
      const page = await connection.history(wave, after, options.pageSize);
      if (!page.items.length) return;
      await this.store_(
        relayId,
        page.items.map((item) => ({ wave, logEpoch: page.logEpoch, item })),
        report
      );
      after = page.items[page.items.length - 1].rseq;
      if (!page.more) return;
    }
  }

  /**
   * Checks what arrived and stores it with the cursors it moves. An event
   * that fails a check moves its cursor too (reading it again would fail
   * again); it is counted and logged.
   */
  private async store_(
    relayId: string,
    arrivals: readonly Arrival[],
    report: RelayIngestReport
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
    const seen = new Set<string>();
    for (const { wave, item } of arrivals) {
      const authRef = String(item.event.auth_ref ?? '').toLowerCase();
      const check = checkRelayEvent(
        item.event,
        item.grant,
        known.get(authRef) ?? null
      );
      const reason = !check.ok
        ? check.reason
        : check.event.wave !== wave
          ? 'event of another wave'
          : check.event.wave.length > MAX_WAVE_CHARS
            ? 'wave id too long'
            : null;
      if (!check.ok || reason) {
        const why = reason ?? 'rejected';
        report.rejected++;
        report.reasons[why] = (report.reasons[why] ?? 0) + 1;
        continue;
      }
      const { event, grant } = check;
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      const isSite = site.has(event.id);
      rows.push({
        event_id: event.id,
        relay_id: relayId,
        wave: event.wave,
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
        status: 'logged',
        status_reason:
          check.grantVia === 'known' ? null : 'grant from the relay',
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
