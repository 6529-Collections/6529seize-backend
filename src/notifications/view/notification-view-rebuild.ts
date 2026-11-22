import { NOTIFICATION_VIEW_TABLE } from '@/constants';
import { dbSupplier, SqlExecutor } from '@/sql-executor';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import {
  applyReadReceipt,
  NOTIFY_LOG_LANE,
  NotificationReadReceipt,
  NotifyLogBody,
  restoreArchivedRows
} from '@/notifications/view/notification-archive';
import {
  FeedRunResult,
  notificationFeedRunner,
  NotificationFeed,
  NotificationFeedRunner
} from '@/notifications/view/notification-feed-runner';
import {
  notificationViewCursorsDb,
  NotificationViewCursorsDb
} from '@/notifications/view/notification-view-cursors.db';
import {
  derivedCauseCuts,
  legacyOutputEnabled,
  notifyViewMode
} from '@/notifications/view/notify-view-flags';

export interface RebuildResult {
  readonly archivedRows: number;
  readonly receipts: number;
  readonly feeds: readonly FeedRunResult[];
}

function cutsMatch(recorded: Record<string, number>): boolean {
  const current = derivedCauseCuts();
  const keys = Object.keys(recorded);
  return (
    keys.length === current.size &&
    keys.every((cause) => current.get(cause as never) === recorded[cause])
  );
}

/**
 * Rebuilds notification_view from empty, from what a rebuild may read: the
 * record log's notify entries (the archive of CARRIED rows, the cuts and
 * the read marks) and the feeds (the chain and relay indexes). Run with the
 * production flags; it refuses a log whose cuts differ from them.
 */
export class NotificationViewRebuild {
  constructor(
    private readonly db: () => SqlExecutor,
    private readonly cursors: NotificationViewCursorsDb,
    private readonly runner: NotificationFeedRunner
  ) {}

  async rebuild(args: {
    readonly entries: AsyncIterable<RecordLogEntry>;
    readonly feeds: readonly NotificationFeed<unknown>[];
    readonly batchSize?: number;
  }): Promise<RebuildResult> {
    if (notifyViewMode() !== 'on') {
      throw new Error('Rebuild the notification view with NOTIFY_VIEW_MODE=on');
    }
    // A replay would otherwise write identity_notifications copies again.
    if (legacyOutputEnabled()) {
      throw new Error(
        'Rebuild the notification view with NOTIFY_LEGACY_OUTPUT=false'
      );
    }
    await this.db().execute(`delete from ${NOTIFICATION_VIEW_TABLE}`);
    await this.cursors.clear(args.feeds.map((feed) => feed.name));
    const receipts: NotificationReadReceipt[] = [];
    let archivedRows = 0;
    for await (const entry of args.entries) {
      if (entry.t !== 'entry' || entry.lane !== NOTIFY_LOG_LANE) continue;
      const body = entry.body as unknown as NotifyLogBody;
      if (body.type === 'notify-archive') {
        await this.db().executeNativeQueriesInTransaction((connection) =>
          restoreArchivedRows(this.db(), body.rows, connection)
        );
        archivedRows += body.rows.length;
      } else if (body.type === 'notify-cuts') {
        if (!cutsMatch(body.cuts)) {
          throw new Error(
            `The log's cuts ${JSON.stringify(body.cuts)} differ from NOTIFY_DERIVED_CAUSES`
          );
        }
      } else if (body.type === 'notify-read') {
        const { type: _type, v: _v, ...receipt } = body;
        receipts.push(receipt as NotificationReadReceipt);
      }
    }
    const feeds: FeedRunResult[] = [];
    for (const feed of args.feeds) {
      feeds.push(
        await this.runner.run(feed, {
          mode: 'replay',
          batchSize: args.batchSize,
          maxBatches: Number.MAX_SAFE_INTEGER
        })
      );
    }
    // Read marks go last, over every row, in the order they were made.
    for (const receipt of receipts) {
      await this.db().executeNativeQueriesInTransaction((connection) =>
        applyReadReceipt(this.db(), receipt, connection)
      );
    }
    return { archivedRows, receipts: receipts.length, feeds };
  }
}

export const notificationViewRebuild = new NotificationViewRebuild(
  dbSupplier,
  notificationViewCursorsDb,
  notificationFeedRunner
);
