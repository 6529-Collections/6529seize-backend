import { Logger } from '@/logging';
import { dbSupplier, SqlExecutor } from '@/sql-executor';
import type { DerivedGroup } from '@/notifications/view/derived-notification';
import {
  DeriveResult,
  notificationDeriver,
  NotificationDeriver
} from '@/notifications/view/notification-deriver';
import {
  notificationViewCursorsDb,
  NotificationViewCursorsDb
} from '@/notifications/view/notification-view-cursors.db';
import { notifyViewMode } from '@/notifications/view/notify-view-flags';

/** A batch of source events after a cursor, and the cursor after them. */
export interface FeedBatch<E> {
  readonly events: readonly E[];
  /** The cursor after the last event; null when the batch is empty. */
  readonly next: string | null;
}

/**
 * One source of notifications: an index's event log read in its own order
 * (chain height and transaction index, a drop index's sequence, a records
 * log's position) and the rule that turns each event into a group.
 */
export interface NotificationFeed<E> {
  /** The cursor's key; one per feed, stable across deploys. */
  readonly name: string;
  /** At most `limit` events after `after` (null: from the start). */
  read(after: string | null, limit: number): Promise<FeedBatch<E>>;
  derive(event: E): Promise<DerivedGroup>;
}

export interface FeedRunOptions {
  /** `live` for the scheduled run; `replay` for a rebuild (never pushes). */
  readonly mode: 'live' | 'replay';
  /** Events per batch; each batch commits with its cursor. */
  readonly batchSize?: number;
  /** Stop after this many batches, so a run fits its time budget. */
  readonly maxBatches?: number;
  /** The clock for the push window (tests). */
  readonly now?: number;
}

export interface FeedRunResult {
  readonly feed: string;
  readonly events: number;
  readonly batches: number;
  readonly derived: DeriveResult;
}

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MAX_BATCHES = 50;

/**
 * Reads each feed from its cursor, derives, and writes. A batch's rows and
 * the cursor after it commit in one transaction, so a crash repeats at most
 * that batch, and repeating it writes the same rows.
 */
export class NotificationFeedRunner {
  private readonly logger = Logger.get(NotificationFeedRunner.name);

  constructor(
    private readonly db: () => SqlExecutor,
    private readonly cursors: NotificationViewCursorsDb,
    private readonly deriver: NotificationDeriver
  ) {}

  async runAll(
    feeds: readonly NotificationFeed<unknown>[],
    options: FeedRunOptions
  ): Promise<FeedRunResult[]> {
    const results: FeedRunResult[] = [];
    for (const feed of feeds) {
      results.push(await this.run(feed, options));
    }
    return results;
  }

  async run<E>(
    feed: NotificationFeed<E>,
    options: FeedRunOptions
  ): Promise<FeedRunResult> {
    const totals = { written: 0, removed: 0, legacyCopies: 0, pushed: 0 };
    let events = 0;
    let batches = 0;
    // With the view off nothing is derived, so the cursor must not move.
    if (notifyViewMode() === 'off') {
      return { feed: feed.name, events, batches, derived: totals };
    }
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
    while (batches < maxBatches) {
      const after = await this.cursors.get(feed.name);
      const batch = await feed.read(after, batchSize);
      if (!batch.events.length || batch.next === null) break;
      const groups: DerivedGroup[] = [];
      for (const event of batch.events) {
        groups.push(await feed.derive(event));
      }
      const next = batch.next;
      const result = await this.db().executeNativeQueriesInTransaction(
        async (connection) => {
          // Another runner moved the cursor: leave this batch to it.
          if ((await this.cursors.get(feed.name, connection)) !== after) {
            return null;
          }
          const derived = await this.deriver.apply(
            groups,
            { mode: options.mode, now: options.now },
            { connection }
          );
          await this.cursors.set(feed.name, next, connection);
          return derived;
        }
      );
      if (!result) {
        this.logger.warn(`[NOTIFY_FEED_CURSOR_MOVED] [FEED ${feed.name}]`);
        break;
      }
      totals.written += result.written;
      totals.removed += result.removed;
      totals.legacyCopies += result.legacyCopies;
      totals.pushed += result.pushed;
      events += batch.events.length;
      batches++;
    }
    return { feed: feed.name, events, batches, derived: totals };
  }
}

export const notificationFeedRunner = new NotificationFeedRunner(
  dbSupplier,
  notificationViewCursorsDb,
  notificationDeriver
);
