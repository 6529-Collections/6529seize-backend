import {
  IDENTITY_NOTIFICATIONS_TABLE,
  NOTIFICATION_VIEW_TABLE
} from '@/constants';
import { NotificationViewOrigin } from '@/entities/INotificationView';
import { dbSupplier, ConnectionWrapper, SqlExecutor } from '@/sql-executor';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { identityNotificationsDb } from '@/notifications/identity-notifications.db';
import {
  applyDelete,
  applyReadReceipt,
  applyVisibility,
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
  notificationViewDb,
  NotificationViewDb
} from '@/notifications/view/notification-view.db';
import {
  derivedCauseCuts,
  legacyOutputEnabled,
  notifyViewMode
} from '@/notifications/view/notify-view-flags';

export interface RebuildResult {
  readonly archivedRows: number;
  readonly receipts: number;
  /** Logged deletes, merges and visibility changes applied after the replay. */
  readonly changes: number;
  /** Derived rows matched again to their identity_notifications copies. */
  readonly relinkedCopies: number;
  readonly feeds: readonly FeedRunResult[];
}

/** What the log holds besides archived rows, applied after the replay in log order. */
type LoggedChange =
  | { readonly kind: 'read'; readonly receipt: NotificationReadReceipt }
  | Extract<
      NotifyLogBody,
      { type: 'notify-delete' | 'notify-merge' | 'notify-visibility' }
    >;

const notifyBodies = async function* (
  entries: AsyncIterable<RecordLogEntry>
): AsyncGenerator<NotifyLogBody> {
  for await (const entry of entries) {
    if (entry.t !== 'entry' || entry.lane !== NOTIFY_LOG_LANE) continue;
    yield entry.body as unknown as NotifyLogBody;
  }
};

/**
 * A cause's cut never changes once set, and causes may join later, so each
 * logged cuts entry must agree with the flags on every cause it names.
 */
function checkCuts(recorded: Record<string, number>): void {
  const current = derivedCauseCuts();
  const changed = Object.entries(recorded).filter(
    ([cause, cut]) => current.get(cause as never) !== cut
  );
  if (changed.length) {
    throw new Error(
      `The log's cuts ${changed
        .map(([cause, cut]) => `${cause}@${cut}`)
        .join(', ')} differ from NOTIFY_DERIVED_CAUSES`
    );
  }
}

const RELINK_CHUNK = 500;

/**
 * Rebuilds notification_view from empty, from what a rebuild may read: the
 * record log's notify entries (the archive of CARRIED rows, the cuts, the
 * read marks and the changes made to rows after they were archived) and
 * the feeds (the chain and relay indexes).
 *
 * Run it on a copy of the database, or with the feed runners, the push
 * worker and the API's notification routes stopped: it empties the view
 * first, and a write in between would be lost or rebuilt twice.
 */
export class NotificationViewRebuild {
  constructor(
    private readonly db: () => SqlExecutor,
    private readonly cursors: NotificationViewCursorsDb,
    private readonly runner: NotificationFeedRunner,
    private readonly viewDb: Pick<NotificationViewDb, 'setLegacyIds'>,
    private readonly merge: (
      source: string,
      target: string,
      connection: ConnectionWrapper<any>
    ) => Promise<void>
  ) {}

  /**
   * `entries` opens the log from its start; it is read twice, once to check
   * it before anything changes and once to rebuild.
   */
  async rebuild(args: {
    readonly entries: () => AsyncIterable<RecordLogEntry>;
    readonly feeds: readonly NotificationFeed<unknown>[];
    readonly batchSize?: number;
  }): Promise<RebuildResult> {
    await this.checkBefore(args.entries);
    await this.db().execute(`delete from ${NOTIFICATION_VIEW_TABLE}`);
    await this.cursors.clear(args.feeds.map((feed) => feed.name));
    const changes: LoggedChange[] = [];
    let archivedRows = 0;
    let receipts = 0;
    for await (const body of notifyBodies(args.entries())) {
      switch (body.type) {
        case 'notify-archive':
          await this.db().executeNativeQueriesInTransaction((connection) =>
            restoreArchivedRows(this.db(), body.rows, connection)
          );
          archivedRows += body.rows.length;
          break;
        case 'notify-delete':
          // An edit's delete of CARRIED rows is followed in the log by
          // their old writer's new rows, so it applies in log order. A
          // delete of drops or waves is final and waits for the replay.
          if (body.carried_only) {
            await this.db().executeNativeQueriesInTransaction((connection) =>
              applyDelete(this.db(), body, connection)
            );
          } else {
            changes.push(body);
          }
          break;
        case 'notify-read': {
          const { type: _type, v: _v, ...receipt } = body;
          changes.push({ kind: 'read', receipt });
          receipts++;
          break;
        }
        case 'notify-merge':
        case 'notify-visibility':
          changes.push(body);
          break;
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
    // Changes and read marks go last, over every row, in the order made.
    for (const change of changes) {
      await this.db().executeNativeQueriesInTransaction((connection) =>
        this.applyChange(change, connection)
      );
    }
    const relinkedCopies = await this.relinkCopies();
    return {
      archivedRows,
      receipts,
      changes: changes.length - receipts,
      relinkedCopies,
      feeds
    };
  }

  /**
   * Refuses before anything changes: without `on` and legacy output off, a
   * replay would write identity_notifications copies again; a log whose
   * cuts disagree with the flags would derive other rows; and CARRIED rows
   * not yet in the archive would be lost.
   */
  private async checkBefore(
    entries: () => AsyncIterable<RecordLogEntry>
  ): Promise<void> {
    if (notifyViewMode() !== 'on') {
      throw new Error('Rebuild the notification view with NOTIFY_VIEW_MODE=on');
    }
    if (legacyOutputEnabled()) {
      throw new Error(
        'Rebuild the notification view with NOTIFY_LEGACY_OUTPUT=false'
      );
    }
    const unsealed = await this.db().oneOrNull<{ n: number }>(
      `select count(*) as n from ${NOTIFICATION_VIEW_TABLE}
       where origin = :origin and sealed = false`,
      { origin: NotificationViewOrigin.CARRIED }
    );
    if (Number(unsealed?.n ?? 0) > 0) {
      throw new Error(
        `${unsealed?.n} CARRIED rows are not in the archive yet: run the seal step first`
      );
    }
    for await (const body of notifyBodies(entries())) {
      if (body.type === 'notify-cuts') checkCuts(body.cuts);
    }
  }

  private async applyChange(
    change: LoggedChange,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    if ('kind' in change) {
      await applyReadReceipt(this.db(), change.receipt, connection);
      return;
    }
    switch (change.type) {
      case 'notify-delete':
        await applyDelete(this.db(), change, connection);
        return;
      case 'notify-merge':
        await this.merge(change.source, change.target, connection);
        return;
      case 'notify-visibility':
        await applyVisibility(
          this.db(),
          change.wave_id,
          change.visibility_group_id,
          connection
        );
        return;
    }
  }

  /**
   * A derived row's identity_notifications copy outlives the view. Where it
   * still exists (written while legacy output was on), the rebuilt row
   * names it again, matched on every column the copy took from the row.
   */
  private async relinkCopies(): Promise<number> {
    const pairs = await this.db().execute<{
      identity_id: string;
      source_key: string;
      legacy_id: number;
    }>(
      `select v.identity_id, v.source_key, n.id as legacy_id
       from ${NOTIFICATION_VIEW_TABLE} v
       join ${IDENTITY_NOTIFICATIONS_TABLE} n
         on n.identity_id = v.identity_id
        and n.cause = v.cause
        and n.created_at = v.created_at
        and n.additional_identity_id <=> v.additional_identity_id
        and n.related_drop_id <=> v.related_drop_id
        and n.related_drop_part_no <=> v.related_drop_part_no
        and n.related_drop_2_id <=> v.related_drop_2_id
        and n.related_drop_2_part_no <=> v.related_drop_2_part_no
        and n.wave_id <=> v.wave_id
       where v.origin = :origin and v.legacy_id is null
       order by v.identity_id, v.source_key, n.id`,
      { origin: NotificationViewOrigin.DERIVED }
    );
    // One copy per row and one row per copy: the first match of each.
    const rows = new Set<string>();
    const copies = new Set<number>();
    const links = pairs.filter((pair) => {
      const row = `${pair.identity_id}:${pair.source_key}`;
      const copy = Number(pair.legacy_id);
      if (rows.has(row) || copies.has(copy)) return false;
      rows.add(row);
      copies.add(copy);
      return true;
    });
    for (let i = 0; i < links.length; i += RELINK_CHUNK) {
      const chunk = links.slice(i, i + RELINK_CHUNK);
      await this.db().executeNativeQueriesInTransaction((connection) =>
        this.viewDb.setLegacyIds(
          chunk.map((link) => ({
            identity_id: link.identity_id,
            source_key: link.source_key,
            legacy_id: Number(link.legacy_id)
          })),
          connection
        )
      );
    }
    return links.length;
  }
}

export const notificationViewRebuild = new NotificationViewRebuild(
  dbSupplier,
  notificationViewCursorsDb,
  notificationFeedRunner,
  notificationViewDb,
  (source, target, connection) =>
    identityNotificationsDb.moveViewRows(source, target, connection)
);
