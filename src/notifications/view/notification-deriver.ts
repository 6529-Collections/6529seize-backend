import { isActivated } from '@/api/push-notifications/push-notifications.service';
import { NotificationViewOrigin } from '@/entities/INotificationView';
import {
  identityNotificationsDb,
  IdentityNotificationsDb
} from '@/notifications/identity-notifications.db';
import { PushNotificationOutboxDb } from '@/notifications/push-notification-outbox.db';
import { RequestContext } from '@/request.context';
import { ConnectionWrapper, dbSupplier, SqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import { canonicalizeJson } from '@/profile-cms/protocol/v1/canonical-json';
import type {
  DerivedGroup,
  DerivedNotification
} from '@/notifications/view/derived-notification';
import {
  notificationSourceKey,
  notificationViewId
} from '@/notifications/view/notification-view-ids';
import {
  notificationViewDb,
  NotificationViewDb,
  NotificationViewRow,
  StoredViewRow
} from '@/notifications/view/notification-view.db';
import {
  notifyViewMode,
  writesLegacyCopy,
  writesViewRow
} from '@/notifications/view/notify-view-flags';

/** A derived row is pushed only while it is this fresh. */
export const PUSH_LIVE_WINDOW_MS = 15 * 60 * 1000;

export interface DeriveOptions {
  /**
   * `live` for new source events; `replay` for a rebuild or a catch-up over
   * events already seen. A replay never pushes.
   */
  readonly mode: 'live' | 'replay';
  /** The clock for the live window (tests). */
  readonly now?: number;
}

export interface DeriveResult {
  readonly written: number;
  readonly removed: number;
  readonly legacyCopies: number;
  readonly pushed: number;
}

interface KeyedRow {
  readonly derived: DerivedNotification;
  readonly view: NotificationViewRow;
}

const rowKey = (row: { identity_id: string; source_key: string }) =>
  `${row.identity_id}\u0000${row.source_key}`;

/** MySQL's JSON column reorders keys, so compare the canonical forms. */
const sameJson = (a: string, b: string): boolean =>
  canonicalizeJson(JSON.parse(a)) === canonicalizeJson(JSON.parse(b));

/** The columns a re-derivation may change; read state and ids are not among them. */
const COMPARED_COLUMNS = [
  'cause',
  'created_at',
  'additional_identity_id',
  'related_drop_id',
  'related_drop_part_no',
  'related_drop_2_id',
  'related_drop_2_part_no',
  'visibility_group_id',
  'wave_id'
] as const;

/** Whether a stored row differs from its re-derived row. */
function changed(stored: StoredViewRow, next: NotificationViewRow): boolean {
  return (
    COMPARED_COLUMNS.some((column) => stored[column] !== next[column]) ||
    !sameJson(stored.additional_data, next.additional_data)
  );
}

/**
 * Writes what the rules derive. Each group replaces the rows of its
 * (family, ref) in notification_view, so applying it again, or applying a
 * later group with fewer rows, converges on the same table. For a cause in
 * NOTIFY_DERIVED_CAUSES it also keeps identity_notifications current, which
 * readers use until the mode is `on` and which a rollback returns to.
 */
export class NotificationDeriver {
  constructor(
    private readonly db: () => SqlExecutor,
    private readonly viewDb: NotificationViewDb,
    private readonly notificationsDb: IdentityNotificationsDb,
    private readonly outbox: PushNotificationOutboxDb,
    private readonly pushActivated: () => boolean = isActivated
  ) {}

  async apply(
    groups: readonly DerivedGroup[],
    options: DeriveOptions,
    ctx: RequestContext
  ): Promise<DeriveResult> {
    const empty = { written: 0, removed: 0, legacyCopies: 0, pushed: 0 };
    if (notifyViewMode() === 'off' || !groups.length) return empty;
    if (!ctx.connection) {
      return this.db().executeNativeQueriesInTransaction((connection) =>
        this.apply(groups, options, { ...ctx, connection })
      );
    }
    const totals = { ...empty };
    for (const group of groups) {
      const result = await this.applyGroup(group, options, ctx.connection);
      totals.written += result.written;
      totals.removed += result.removed;
      totals.legacyCopies += result.legacyCopies;
      totals.pushed += result.pushed;
    }
    return totals;
  }

  private async applyGroup(
    group: DerivedGroup,
    options: DeriveOptions,
    connection: ConnectionWrapper<any>
  ): Promise<DeriveResult> {
    const allowed = await this.notificationsDb.filterDerivedRowsForWrite(
      group.rows.filter((row) => writesViewRow(row.cause, row.created_at)),
      connection
    );
    const keyed = this.keyRows(group, allowed);
    const stored = new Map(
      (
        await this.viewDb.findGroupForUpdate(
          group.family,
          group.ref,
          connection
        )
      ).map((row) => [rowKey(row), row])
    );
    const nextKeys = new Set(keyed.map(({ view }) => rowKey(view)));
    const removed = Array.from(stored.values()).filter(
      (row) => !nextKeys.has(rowKey(row))
    );
    await this.viewDb.deleteRows(removed, connection);
    await this.notificationsDb.deleteDerivedCopies(
      removed.flatMap((row) => (row.legacy_id === null ? [] : [row.legacy_id])),
      connection
    );
    const toWrite = keyed.filter(({ view }) => {
      const before = stored.get(rowKey(view));
      return !before || changed(before, view);
    });
    await this.viewDb.upsertRows(
      toWrite.map(({ view }) => view),
      connection
    );
    const copies = await this.writeLegacyCopies(
      keyed,
      stored,
      options,
      connection
    );
    return {
      written: toWrite.length,
      removed: removed.length,
      legacyCopies: copies.written,
      pushed: copies.pushed
    };
  }

  private keyRows(
    group: DerivedGroup,
    rows: readonly DerivedNotification[]
  ): KeyedRow[] {
    const seen = new Set<string>();
    const keyed: KeyedRow[] = [];
    for (const derived of rows) {
      const sourceKey = notificationSourceKey(
        group.family,
        group.ref,
        derived.identity_id
      );
      const key = rowKey({
        identity_id: derived.identity_id,
        source_key: sourceKey
      });
      if (seen.has(key)) {
        throw new Error(
          `Rule ${group.family} derived two rows for one recipient of ${group.ref}`
        );
      }
      seen.add(key);
      keyed.push({
        derived,
        view: {
          identity_id: derived.identity_id,
          source_key: sourceKey,
          id: notificationViewId(derived.created_at, sourceKey),
          source_family: group.family,
          source_ref: group.ref,
          origin: NotificationViewOrigin.DERIVED,
          additional_identity_id: derived.additional_identity_id,
          related_drop_id: derived.related_drop_id,
          related_drop_part_no: derived.related_drop_part_no,
          related_drop_2_id: derived.related_drop_2_id,
          related_drop_2_part_no: derived.related_drop_2_part_no,
          cause: derived.cause,
          additional_data: JSON.stringify(derived.additional_data ?? {}),
          created_at: derived.created_at,
          visibility_group_id: derived.visibility_group_id,
          wave_id: derived.wave_id
        }
      });
    }
    return keyed;
  }

  /**
   * identity_notifications copies of derived causes: written once per row
   * (the view row remembers the copy's id), updated when a re-derivation
   * changes the row, pushed only when new, live and fresh.
   */
  private async writeLegacyCopies(
    keyed: readonly KeyedRow[],
    stored: ReadonlyMap<string, StoredViewRow>,
    options: DeriveOptions,
    connection: ConnectionWrapper<any>
  ): Promise<{ written: number; pushed: number }> {
    const fresh: KeyedRow[] = [];
    for (const row of keyed) {
      if (!writesLegacyCopy(row.derived.cause, row.derived.created_at)) {
        continue;
      }
      const before = stored.get(rowKey(row.view));
      if (before?.legacy_id == null) {
        fresh.push(row);
      } else if (changed(before, row.view)) {
        await this.notificationsDb.updateDerivedCopy(
          before.legacy_id,
          row.derived,
          connection
        );
      }
    }
    if (!fresh.length) return { written: 0, pushed: 0 };
    const ids = await this.notificationsDb.insertDerivedCopies(
      fresh.map(({ derived }) => derived),
      connection
    );
    await this.viewDb.setLegacyIds(
      fresh.map(({ view }, index) => ({
        identity_id: view.identity_id,
        source_key: view.source_key,
        legacy_id: ids[index]
      })),
      connection
    );
    const now = options.now ?? Time.currentMillis();
    const pushIds =
      options.mode === 'live' && this.pushActivated()
        ? ids.filter(
            (_, index) =>
              fresh[index].derived.created_at >= now - PUSH_LIVE_WINDOW_MS
          )
        : [];
    await this.outbox.enqueueMany(pushIds, { connection });
    return { written: ids.length, pushed: pushIds.length };
  }
}

export const notificationDeriver = new NotificationDeriver(
  dbSupplier,
  notificationViewDb,
  identityNotificationsDb,
  new PushNotificationOutboxDb(dbSupplier)
);
