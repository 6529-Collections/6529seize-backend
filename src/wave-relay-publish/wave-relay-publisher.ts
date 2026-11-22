import { CrpAck } from './crp-client';

/**
 * Publishes 6529.io's device-signed drop events (posts, edits, deletes,
 * reactions) to the 6529 relays, so the relays carry real traffic before
 * waves switch on and every signed write made here reaches them after.
 *
 * Each relay has its own cursor over the stored events in (created_at, id)
 * order, so a relay that is down catches up when it is back. An event is
 * sent only for what 6529.io shows now: a post or edit of a drop that still
 * exists, is author-signed and is visible to a reader who is not signed in;
 * a reaction to such a drop; any delete. A write still in flight holds the
 * cursor until it finishes, or is passed over once abandoned.
 */

/** A stored event as `GET /drops/{id}/signed-events` serves it. */
export interface PublishableEvent {
  readonly id: string;
  readonly kind: number;
  readonly created_at: number;
  readonly auth_ref: string;
  readonly [field: string]: unknown;
}

/** An event after the cursor, with what decides whether it is sent. */
export interface CandidateEvent {
  readonly event: PublishableEvent;
  /** The write it authorized finished (the event names its drop). */
  readonly finalized: boolean;
  /** The drop exists and a reader who is not signed in can see it. */
  readonly dropVisible: boolean;
  /** The drop's content is author-signed now (its current signature). */
  readonly dropSigned: boolean;
}

export const EVENT_KIND = { POST: 1, EDIT: 2, TOMBSTONE: 3, REACT: 4 } as const;

export type PublishDecision = 'publish' | 'skip' | 'wait';

/**
 * Whether an event is sent, passed over, or holds the cursor (a write still
 * in flight).
 */
export function publishDecision(
  candidate: CandidateEvent,
  now: number,
  abandonAfterMs: number
): PublishDecision {
  if (!candidate.finalized) {
    return Number(candidate.event.created_at) <= now - abandonAfterMs
      ? 'skip'
      : 'wait';
  }
  switch (Number(candidate.event.kind)) {
    case EVENT_KIND.TOMBSTONE:
      return 'publish';
    case EVENT_KIND.REACT:
      return candidate.dropVisible ? 'publish' : 'skip';
    case EVENT_KIND.POST:
    case EVENT_KIND.EDIT:
      return candidate.dropVisible && candidate.dropSigned ? 'publish' : 'skip';
    default:
      return 'skip';
  }
}

export interface RelayCursor {
  readonly createdAt: number;
  readonly eventId: string;
  /** Events the relay took or already held. */
  readonly published: number;
  /** Events the relay refused for good. */
  readonly rejected: number;
  /** Events passed over here (not what 6529.io shows, or abandoned). */
  readonly skipped: number;
  readonly lastError: string | null;
  /** The event runs keep stopping at, and how many runs in a row. */
  readonly stuckEventId: string | null;
  readonly stuckCount: number;
}

export const START_CURSOR: RelayCursor = {
  createdAt: 0,
  eventId: '',
  published: 0,
  rejected: 0,
  skipped: 0,
  lastError: null,
  stuckEventId: null,
  stuckCount: 0
};

export interface PublishableEventsSource {
  /** Events after the cursor and created before `before`, oldest first. */
  candidatesAfter(
    cursor: Pick<RelayCursor, 'createdAt' | 'eventId'>,
    before: number,
    limit: number
  ): Promise<CandidateEvent[]>;
  /** Grant proofs by id, as `GET /drops/{id}/signed-events` serves them. */
  grants(ids: string[]): Promise<Map<string, unknown>>;
}

export interface RelayCursorStore {
  load(relay: string): Promise<RelayCursor>;
  save(relay: string, cursor: RelayCursor): Promise<void>;
}

export interface RelayConnection {
  publish(event: unknown, grant: unknown): Promise<CrpAck>;
  close(): void;
}

export interface WaveRelayPublisherOptions {
  readonly relays: readonly string[];
  /** Stop starting new work after this long. */
  readonly budgetMs: number;
  readonly batchSize: number;
  /** Read only events at least this old. */
  readonly graceMs: number;
  /** A write that hasn't finished after this long was abandoned. */
  readonly abandonAfterMs: number;
  /** Publishes in flight at once on one connection. */
  readonly window: number;
  /** Least time between two publishes on one connection. */
  readonly minIntervalMs: number;
  /** One grant's publishes a second, and its burst (under a relay's limit). */
  readonly grantRate: number;
  readonly grantBurst: number;
  /** After this many runs in a row stopped at the same event, pass it over. */
  readonly maxStuckRuns: number;
}

export interface RelayRunResult {
  readonly relay: string;
  readonly published: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly skipped: number;
  readonly stoppedBy: string | null;
}

/** The most one event (with its grant) may take: a relay's MAX_ITEMS_BYTES. */
export const MAX_EVENT_BYTES = 96 * 1024;

/** A relay's answer that means "not now": send the same event again later. */
export function isRetryableRejection(reason: string | null): boolean {
  return (
    !!reason &&
    /rate limit|could not be read|^store:|no such wave|unavailable|timed? ?out/i.test(
      reason
    )
  );
}

/** The serialized size a relay counts for an event and its grant. */
export function eventBytes(event: unknown, grant: unknown): number {
  return Buffer.byteLength(JSON.stringify({ rseq: 0, event, grant }), 'utf8');
}

type Outcome = 'published' | 'duplicate' | 'rejected' | 'skipped';

/** Local copy of a relay's per-grant token bucket, a little slower. */
class GrantPacer {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly rate: number,
    private readonly burst: number
  ) {}

  /** The earliest time at or after `at` this grant may publish; takes it. */
  take(grant: string, at: number): number {
    const bucket = this.buckets.get(grant) ?? { tokens: this.burst, at };
    const refilled = Math.min(
      this.burst,
      bucket.tokens + ((at - bucket.at) / 1000) * this.rate
    );
    if (refilled >= 1) {
      this.buckets.set(grant, { tokens: refilled - 1, at });
      return at;
    }
    const wait = ((1 - refilled) / this.rate) * 1000;
    this.buckets.set(grant, { tokens: 0, at: at + wait });
    return at + wait;
  }
}

export class WaveRelayPublisher {
  constructor(
    private readonly events: PublishableEventsSource,
    private readonly cursors: RelayCursorStore,
    private readonly connect: (relay: string) => Promise<RelayConnection>,
    private readonly log: (message: string) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  async publishPending(
    options: WaveRelayPublisherOptions
  ): Promise<RelayRunResult[]> {
    const deadline = this.now() + options.budgetMs;
    const results: RelayRunResult[] = [];
    // One relay after another: the run ends with every relay settled.
    for (const relay of options.relays) {
      results.push(await this.publishToRelay(relay, deadline, options));
    }
    return results;
  }

  private async publishToRelay(
    relay: string,
    deadline: number,
    options: WaveRelayPublisherOptions
  ): Promise<RelayRunResult> {
    let cursor = await this.cursors.load(relay);
    const totals = { published: 0, duplicates: 0, rejected: 0, skipped: 0 };
    let stoppedBy: string | null = null;
    let stoppedAt: string | null = null;
    let connection: RelayConnection | null = null;
    const pacer = new GrantPacer(options.grantRate, options.grantBurst);
    try {
      while (this.now() < deadline) {
        const batch = await this.events.candidatesAfter(
          cursor,
          this.now() - options.graceMs,
          options.batchSize
        );
        if (!batch.length) break;
        const grants = await this.events.grants(
          Array.from(new Set(batch.map((c) => c.event.auth_ref)))
        );
        const outcome = await this.publishBatch(
          batch,
          grants,
          async () => (connection ??= await this.connect(relay)),
          pacer,
          deadline,
          cursor,
          options
        );
        totals.published += outcome.counts.published;
        totals.duplicates += outcome.counts.duplicates;
        totals.rejected += outcome.counts.rejected;
        totals.skipped += outcome.counts.skipped;
        if (outcome.done > 0) {
          const last = batch[outcome.done - 1].event;
          cursor = {
            ...cursor,
            createdAt: Number(last.created_at),
            eventId: last.id,
            published:
              cursor.published +
              outcome.counts.published +
              outcome.counts.duplicates,
            rejected: cursor.rejected + outcome.counts.rejected,
            skipped: cursor.skipped + outcome.counts.skipped,
            lastError: null,
            stuckEventId: null,
            stuckCount: 0
          };
          await this.cursors.save(relay, cursor);
        }
        if (outcome.stoppedBy) {
          stoppedBy = outcome.stoppedBy;
          stoppedAt = batch[outcome.done]?.event.id ?? null;
          break;
        }
        if (outcome.done < batch.length) break;
      }
    } catch (error) {
      stoppedBy = String((error as Error)?.message ?? error);
    } finally {
      (connection as RelayConnection | null)?.close();
    }
    if (stoppedBy) {
      const stuckCount =
        stoppedAt && stoppedAt === cursor.stuckEventId
          ? cursor.stuckCount + 1
          : 1;
      cursor = {
        ...cursor,
        lastError: stoppedBy,
        stuckEventId: stoppedAt,
        stuckCount: stoppedAt ? stuckCount : 0
      };
      await this.cursors.save(relay, cursor);
    }
    if (totals.published || totals.rejected || stoppedBy) {
      this.log(
        `[RELAY ${relay}] [PUBLISHED ${totals.published}] [DUPLICATES ${totals.duplicates}] [REJECTED ${totals.rejected}] [SKIPPED ${totals.skipped}]${stoppedBy ? ` [STOPPED ${stoppedBy}]` : ''}`
      );
    }
    return { relay, ...totals, stoppedBy };
  }

  /**
   * Sends a batch in order, `window` at a time, paced per connection and
   * per grant. `done` counts the events from the start of the batch that
   * are settled (published, already held, refused for good, or passed
   * over); the cursor moves past those only.
   */
  private async publishBatch(
    batch: CandidateEvent[],
    grants: Map<string, unknown>,
    connection: () => Promise<RelayConnection>,
    pacer: GrantPacer,
    deadline: number,
    cursor: RelayCursor,
    options: WaveRelayPublisherOptions
  ): Promise<{
    done: number;
    counts: {
      published: number;
      duplicates: number;
      rejected: number;
      skipped: number;
    };
    stoppedBy: string | null;
  }> {
    const counts = { published: 0, duplicates: 0, rejected: 0, skipped: 0 };
    const settle = (outcome: Outcome) => {
      if (outcome === 'published') counts.published++;
      else if (outcome === 'duplicate') counts.duplicates++;
      else if (outcome === 'rejected') counts.rejected++;
      else counts.skipped++;
    };
    let done = 0;
    let nextSend = this.now();
    while (done < batch.length) {
      // Decide the next window: events passed over settle at once; a write
      // in flight ends the batch here.
      const window: { index: number; sendAt: number; grant: unknown }[] = [];
      let index = done;
      let waiting = false;
      while (index < batch.length && window.length < options.window) {
        const candidate = batch[index];
        const decision = publishDecision(
          candidate,
          this.now(),
          options.abandonAfterMs
        );
        if (decision === 'wait') {
          waiting = true;
          break;
        }
        if (decision === 'skip') {
          if (!window.length) {
            settle('skipped');
            done = ++index;
            continue;
          }
          break;
        }
        const event = candidate.event;
        const grant = grants.get(event.auth_ref);
        const stuck =
          cursor.stuckEventId === event.id &&
          cursor.stuckCount >= options.maxStuckRuns;
        const unsendable =
          grant === undefined ||
          stuck ||
          eventBytes(this.wireEvent(event), grant) > MAX_EVENT_BYTES;
        if (unsendable) {
          if (!window.length) {
            this.log(
              `[RELAY EVENT PASSED OVER ${event.id}] [${grant === undefined ? 'no grant proof stored' : stuck ? `stopped ${cursor.stuckCount} runs in a row` : 'too large for a relay'}]`
            );
            settle('rejected');
            done = ++index;
            continue;
          }
          break;
        }
        const sendAt = pacer.take(
          event.auth_ref.toLowerCase(),
          Math.max(nextSend, this.now())
        );
        if (sendAt >= deadline) break;
        nextSend = sendAt + options.minIntervalMs;
        window.push({ index, sendAt, grant });
        index++;
      }
      if (!window.length) {
        if (waiting) {
          return { done, counts, stoppedBy: null };
        }
        if (done < batch.length && index === done) {
          // Nothing fits before the deadline.
          return { done, counts, stoppedBy: null };
        }
        continue;
      }
      const link = await connection();
      const answers = await Promise.allSettled(
        window.map(async ({ index: i, sendAt, grant }) => {
          const wait = sendAt - this.now();
          if (wait > 0) await this.sleep(wait);
          return link.publish(this.wireEvent(batch[i].event), grant);
        })
      );
      for (let k = 0; k < answers.length; k++) {
        const answer = answers[k];
        const event = batch[window[k].index].event;
        if (answer.status === 'rejected') {
          return {
            done,
            counts,
            stoppedBy: String(answer.reason?.message ?? answer.reason)
          };
        }
        const ack = answer.value;
        if (ack.status === 'rejected' && isRetryableRejection(ack.reason)) {
          return { done, counts, stoppedBy: ack.reason };
        }
        if (ack.status === 'accepted') settle('published');
        else if (ack.status === 'duplicate') settle('duplicate');
        else {
          settle('rejected');
          this.log(
            `[RELAY REFUSED EVENT ${event.id}] [${ack.reason ?? 'no reason'}]`
          );
        }
        done++;
      }
      if (waiting) {
        return { done, counts, stoppedBy: null };
      }
    }
    return { done, counts, stoppedBy: null };
  }

  /** The event as the relay reads it: its signed fields, no stored time. */
  private wireEvent(event: PublishableEvent): Record<string, unknown> {
    const { created_at: _createdAt, ...signed } = event;
    return signed;
  }
}
