import { CrpAck } from './crp-client';

/**
 * Publishes 6529.io's device-signed drop events (posts, edits, deletes,
 * reactions) to the 6529 relays, so the relays carry real traffic before
 * waves switch on and every signed write made here reaches them after.
 * Each relay has its own cursor over the stored events, in (created_at, id)
 * order, so a relay that is down catches up when it is back. An event is
 * published once its write has finished (it names its drop) and it is older
 * than a short grace period, so a write still in flight is never passed
 * over. Direct-message waves are never published.
 */

/** A stored event as `GET /drops/{id}/signed-events` serves it. */
export interface PublishableEvent {
  readonly id: string;
  readonly created_at: number;
  readonly auth_ref: string;
  readonly [field: string]: unknown;
}

export interface RelayCursor {
  readonly createdAt: number;
  readonly eventId: string;
  readonly published: number;
  readonly rejected: number;
  readonly lastError: string | null;
}

export const START_CURSOR: RelayCursor = {
  createdAt: 0,
  eventId: '',
  published: 0,
  rejected: 0,
  lastError: null
};

export interface PublishableEventsSource {
  /** Events after the cursor and created before `before`, oldest first. */
  eventsAfter(
    cursor: Pick<RelayCursor, 'createdAt' | 'eventId'>,
    before: number,
    limit: number
  ): Promise<PublishableEvent[]>;
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
  /** Publish only events at least this old. */
  readonly graceMs: number;
  /** Publishes in flight at once on one connection. */
  readonly window: number;
  /** Least time between two publishes on one connection (a relay's limit). */
  readonly minIntervalMs: number;
}

export interface RelayRunResult {
  readonly relay: string;
  readonly published: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly stoppedBy: string | null;
}

/** A relay's answer that means "not now": try the same event again later. */
export function isRetryableRejection(reason: string | null): boolean {
  return !!reason && /rate limit/i.test(reason);
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
    return Promise.all(
      options.relays.map((relay) =>
        this.publishToRelay(relay, deadline, options)
      )
    );
  }

  private async publishToRelay(
    relay: string,
    deadline: number,
    options: WaveRelayPublisherOptions
  ): Promise<RelayRunResult> {
    let cursor = await this.cursors.load(relay);
    let published = 0;
    let duplicates = 0;
    let rejected = 0;
    let stoppedBy: string | null = null;
    let connection: RelayConnection | null = null;
    try {
      while (this.now() < deadline) {
        const batch = await this.events.eventsAfter(
          cursor,
          this.now() - options.graceMs,
          options.batchSize
        );
        if (!batch.length) break;
        if (!connection) connection = await this.connect(relay);
        const grants = await this.events.grants(
          Array.from(new Set(batch.map((event) => event.auth_ref)))
        );
        const outcome = await this.publishBatch(
          connection,
          batch,
          grants,
          deadline,
          options
        );
        published += outcome.published;
        duplicates += outcome.duplicates;
        rejected += outcome.rejected;
        if (outcome.done > 0) {
          const last = batch[outcome.done - 1];
          cursor = {
            createdAt: Number(last.created_at),
            eventId: last.id,
            published:
              cursor.published + outcome.published + outcome.duplicates,
            rejected: cursor.rejected + outcome.rejected,
            lastError: outcome.stoppedBy
          };
          await this.cursors.save(relay, cursor);
        }
        if (outcome.stoppedBy) {
          stoppedBy = outcome.stoppedBy;
          break;
        }
      }
    } catch (error) {
      stoppedBy = String((error as Error)?.message ?? error);
      await this.cursors.save(relay, { ...cursor, lastError: stoppedBy });
    } finally {
      connection?.close();
    }
    if (published || rejected || stoppedBy) {
      this.log(
        `[RELAY ${relay}] [PUBLISHED ${published}] [DUPLICATES ${duplicates}] [REJECTED ${rejected}]${stoppedBy ? ` [STOPPED ${stoppedBy}]` : ''}`
      );
    }
    return { relay, published, duplicates, rejected, stoppedBy };
  }

  /**
   * Publishes a batch in order, `window` at a time, paced. `done` counts the
   * events from the start of the batch that are settled (accepted, already
   * held, or refused for good); the cursor moves past those only.
   */
  private async publishBatch(
    connection: RelayConnection,
    batch: PublishableEvent[],
    grants: Map<string, unknown>,
    deadline: number,
    options: WaveRelayPublisherOptions
  ): Promise<{
    done: number;
    published: number;
    duplicates: number;
    rejected: number;
    stoppedBy: string | null;
  }> {
    let published = 0;
    let duplicates = 0;
    let rejected = 0;
    for (let start = 0; start < batch.length; start += options.window) {
      if (this.now() >= deadline) {
        return {
          done: start,
          published,
          duplicates,
          rejected,
          stoppedBy: null
        };
      }
      const slice = batch.slice(start, start + options.window);
      const answers = await Promise.allSettled(
        slice.map(async (event, index) => {
          await this.sleep(index * options.minIntervalMs);
          const grant = grants.get(event.auth_ref);
          if (grant === undefined) {
            return {
              status: 'rejected',
              reason: 'no grant proof stored',
              eventId: event.id
            } as CrpAck;
          }
          const { created_at: _createdAt, ...signed } = event;
          return connection.publish(signed, grant);
        })
      );
      for (let i = 0; i < answers.length; i++) {
        const answer = answers[i];
        if (answer.status === 'rejected') {
          return {
            done: start + i,
            published,
            duplicates,
            rejected,
            stoppedBy: String(answer.reason?.message ?? answer.reason)
          };
        }
        const ack = answer.value;
        if (ack.status === 'rejected' && isRetryableRejection(ack.reason)) {
          return {
            done: start + i,
            published,
            duplicates,
            rejected,
            stoppedBy: ack.reason
          };
        }
        if (ack.status === 'accepted') published++;
        else if (ack.status === 'duplicate') duplicates++;
        else {
          rejected++;
          this.log(
            `[RELAY REFUSED EVENT ${slice[i].id}] [${ack.reason ?? 'no reason'}]`
          );
        }
      }
    }
    return {
      done: batch.length,
      published,
      duplicates,
      rejected,
      stoppedBy: null
    };
  }
}
