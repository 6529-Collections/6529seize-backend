import { wsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { isDeadlockError } from '@/db-errors';
import { Logger } from '@/logging';
import { dbSupplier, SqlExecutor } from '@/sql-executor';
import type { DerivedGroup } from '@/notifications/view/derived-notification';
import {
  DeriveCounts,
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
  /**
   * The events read. A feed may skip, as it reads, events no rule would
   * notify for (an import's), so a batch can be empty and still move on.
   */
  readonly events: readonly E[];
  /** The cursor after what was read; null when there was nothing to read. */
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
  /** `live` for the scheduled run; `replay` for a rebuild (never pushes or announces). */
  readonly mode: 'live' | 'replay';
  /** Events per batch; each batch commits with its cursor. */
  readonly batchSize?: number;
  /** Stop after this many batches, so a run fits its time budget. */
  readonly maxBatches?: number;
  /** Start no batch after this time (milliseconds since the epoch). */
  readonly untilMs?: number;
  /** The clock for the push window (tests). */
  readonly now?: number;
}

export interface FeedRunResult {
  readonly feed: string;
  readonly events: number;
  readonly batches: number;
  readonly derived: DeriveCounts;
}

/** Sends IDENTITY_NOTIFICATIONS_CHANGED to these people's open sockets. */
export type AnnounceNotificationChanges = (
  identityIds: string[]
) => Promise<void>;

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MAX_BATCHES = 50;
/** Tries of a batch whose transaction deadlocks; each starts from its cursor. */
const BATCH_ATTEMPTS = 3;

/**
 * Reads each feed from its cursor, derives, and writes. A batch's rows and
 * the cursor after it commit in one transaction, so a crash repeats at most
 * that batch, and repeating it writes the same rows. In `on` mode, after a
 * live batch commits, everyone whose rows it wrote or removed is told once
 * (IDENTITY_NOTIFICATIONS_CHANGED), whether or not a push follows. In
 * `shadow` the push worker tells them as it pushes the copies.
 */
export class NotificationFeedRunner {
  private readonly logger = Logger.get(NotificationFeedRunner.name);

  constructor(
    private readonly db: () => SqlExecutor,
    private readonly cursors: NotificationViewCursorsDb,
    private readonly deriver: NotificationDeriver,
    private readonly announce: AnnounceNotificationChanges = (identityIds) =>
      wsListenersNotifier.notifyAboutIdentityNotificationsChanged(identityIds)
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
    await this.cursors.ensure(feed.name);
    while (
      batches < maxBatches &&
      (options.untilMs === undefined || Date.now() < options.untilMs)
    ) {
      const after = await this.cursors.get(feed.name);
      const batch = await feed.read(after, batchSize);
      if (batch.next === null || batch.next === after) break;
      const groups: DerivedGroup[] = [];
      for (const event of batch.events) {
        groups.push(await feed.derive(event));
      }
      const next = batch.next;
      const result = await this.retryingDeadlocks(feed.name, () =>
        this.db().executeNativeQueriesInTransaction(async (connection) => {
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
        })
      );
      if (!result) {
        this.logger.warn(`[NOTIFY_FEED_CURSOR_MOVED] [FEED ${feed.name}]`);
        break;
      }
      if (options.mode === 'live' && notifyViewMode() === 'on') {
        await this.announceChanges(feed.name, result.changedIdentityIds);
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

  /**
   * A deadlock rolls the batch back whole, cursor included, so trying it
   * again is safe: the transaction re-checks the cursor first.
   */
  private async retryingDeadlocks<T>(
    feedName: string,
    work: () => Promise<T>
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (!isDeadlockError(error) || attempt >= BATCH_ATTEMPTS) throw error;
        this.logger.warn(
          `[NOTIFY_FEED_DEADLOCK_RETRY] [FEED ${feedName}] [ATTEMPT ${attempt}]`
        );
      }
    }
  }

  /** The batch is committed; a lost announcement costs only freshness. */
  private async announceChanges(
    feedName: string,
    identityIds: readonly string[]
  ): Promise<void> {
    if (!identityIds.length) return;
    try {
      await this.announce([...identityIds]);
    } catch (error) {
      this.logger.warn(
        `[NOTIFY_FEED_ANNOUNCE_FAILED] [FEED ${feedName}] ${error}`
      );
    }
  }
}

export const notificationFeedRunner = new NotificationFeedRunner(
  dbSupplier,
  notificationViewCursorsDb,
  notificationDeriver
);
