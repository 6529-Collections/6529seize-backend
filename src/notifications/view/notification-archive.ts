import { NOTIFICATION_VIEW_TABLE } from '@/constants';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { NotificationViewOrigin } from '@/entities/INotificationView';
import { RequestContext } from '@/request.context';
import { ConnectionWrapper, dbSupplier, SqlExecutor } from '@/sql-executor';
import { deviceGrantProofSource } from '@/signed-records/record-grants';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import type { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { RecordLogWriter } from '@/signed-records/record-log/record-log.service';
import {
  notificationSourceKey,
  notificationViewId
} from '@/notifications/view/notification-view-ids';
import { CARRIED_FAMILY } from '@/notifications/view/notification-view.db';
import {
  derivedCauseWindows,
  loggedWindows
} from '@/notifications/view/notify-view-flags';

/** The notification view's entries in the private record log. */
export const NOTIFY_LOG_LANE = 'notify';

/** A CARRIED row as the archive keeps it. */
export interface ArchivedNotificationRow {
  readonly identity_id: string;
  readonly id: number;
  readonly legacy_id: number;
  readonly cause: IdentityNotificationCause;
  readonly additional_identity_id: string | null;
  readonly related_drop_id: string | null;
  readonly related_drop_part_no: number | null;
  readonly related_drop_2_id: string | null;
  readonly related_drop_2_part_no: number | null;
  readonly additional_data: Record<string, unknown>;
  readonly created_at: number;
  readonly read_at: number | null;
  readonly visibility_group_id: string | null;
  readonly wave_id: string | null;
}

/** A read mark someone made through 6529.io, as the archive keeps it. */
export type NotificationReadReceipt =
  | {
      readonly scope: 'one';
      readonly identity_id: string;
      /** The id the client used: a view id or an identity_notifications id. */
      readonly id: number;
      /** null marks it unread. */
      readonly read_at: number | null;
    }
  | {
      readonly scope: 'all';
      readonly identity_id: string;
      readonly read_at: number;
      /** The rows the mark read: a row derived later stays unread. */
      readonly source_keys: readonly string[];
    }
  | {
      readonly scope: 'wave';
      readonly identity_id: string;
      readonly wave_id: string;
      readonly read_at: number;
      readonly source_keys: readonly string[];
    };

export type NotifyLogBody =
  | {
      readonly type: 'notify-archive';
      readonly v: 1;
      readonly rows: ArchivedNotificationRow[];
    }
  | {
      readonly type: 'notify-cuts';
      readonly v: 1;
      /** Each derived cause's windows, [start, end or null], oldest first. */
      readonly windows: Record<string, [number, number | null][]>;
    }
  | ({ readonly type: 'notify-read'; readonly v: 1 } & NotificationReadReceipt)
  | {
      readonly type: 'notify-delete';
      readonly v: 1;
      readonly reference: NotificationReference;
      readonly values: string[];
      /**
       * A drop edit: only the CARRIED rows went (their old writer writes
       * them again); the deriver's rows stay.
       */
      readonly carried_only: boolean;
    }
  | {
      readonly type: 'notify-merge';
      readonly v: 1;
      readonly source: string;
      readonly target: string;
    }
  | {
      readonly type: 'notify-visibility';
      readonly v: 1;
      readonly wave_id: string;
      readonly visibility_group_id: string | null;
    };

/** What a delete names: drops (and rows naming them) or waves. */
export type NotificationReference = 'drop' | 'wave';

/** The rows a delete of these drops or waves removes. */
export function deletedRowsPredicate(reference: NotificationReference): string {
  return reference === 'drop'
    ? '(related_drop_id in (:values) or related_drop_2_id in (:values))'
    : 'wave_id in (:values)';
}

/** Ids per delete entry: well under the log's 4 MiB entry limit. */
const DELETE_VALUES_PER_ENTRY = 10_000;

/** Keys per read-mark entry: about 1.4 MB, under the log's 4 MiB entry limit. */
const READ_KEYS_PER_ENTRY = 20_000;

/** Rows per archive entry: well under the log's 4 MiB entry limit. */
const ARCHIVE_ROWS_PER_ENTRY = 1000;

const toNumberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const entry = (body: NotifyLogBody): RecordLogEntry => ({
  t: 'entry',
  lane: NOTIFY_LOG_LANE,
  chain: 'private',
  body: body as unknown as Record<string, unknown>
});

/**
 * The entries that record a delete of drops or waves, for writers outside
 * a sqlExecutor transaction (the legacy DM purge) to append themselves.
 */
export function notifyDeleteEntries(
  reference: NotificationReference,
  values: readonly string[],
  carriedOnly = false
): RecordLogEntry[] {
  const entries: RecordLogEntry[] = [];
  for (let i = 0; i < values.length; i += DELETE_VALUES_PER_ENTRY) {
    entries.push(
      entry({
        type: 'notify-delete',
        v: 1,
        reference,
        values: values.slice(i, i + DELETE_VALUES_PER_ENTRY),
        carried_only: carriedOnly
      })
    );
  }
  return entries;
}

/** A view row as the archive keeps it. */
function archivedRowOf(row: Record<string, any>): ArchivedNotificationRow {
  return {
    identity_id: row.identity_id,
    id: Number(row.id),
    legacy_id: Number(row.legacy_id),
    cause: row.cause,
    additional_identity_id: row.additional_identity_id,
    related_drop_id: row.related_drop_id,
    related_drop_part_no: toNumberOrNull(row.related_drop_part_no),
    related_drop_2_id: row.related_drop_2_id,
    related_drop_2_part_no: toNumberOrNull(row.related_drop_2_part_no),
    additional_data:
      typeof row.additional_data === 'string'
        ? JSON.parse(row.additional_data)
        : row.additional_data,
    created_at: Number(row.created_at),
    read_at: toNumberOrNull(row.read_at),
    visibility_group_id: row.visibility_group_id,
    wave_id: row.wave_id
  };
}

/**
 * Writes what the notification view cannot derive into the private record
 * log, where 6529.io's service identity seals, pins and archives it: the
 * CARRIED rows (copies of identity_notifications rows from before their
 * cause was derived), the cuts in force, the read marks people make, and
 * the changes to rows after they were archived (deletes of drops and
 * waves, profile merges, wave visibility changes). A rebuild reads them
 * back in order (NotificationViewRebuild).
 */
export class NotificationArchive {
  constructor(
    private readonly db: () => SqlExecutor,
    private readonly log: Pick<RecordLogWriter, 'append'>
  ) {}

  /**
   * Seals one batch of CARRIED rows not yet in the archive; run it until
   * `done`. A batch's entry and its sealed flags commit together.
   */
  async sealCarried(
    batchSize = ARCHIVE_ROWS_PER_ENTRY
  ): Promise<{ rows: number; done: boolean }> {
    return this.db().executeNativeQueriesInTransaction(async (connection) => {
      const rows = await this.db().execute<
        ArchivedNotificationRow & { source_key: string; additional_data: any }
      >(
        `select identity_id, source_key, id, legacy_id, cause,
           additional_identity_id, related_drop_id, related_drop_part_no,
           related_drop_2_id, related_drop_2_part_no, additional_data,
           created_at, read_at, visibility_group_id, wave_id
         from ${NOTIFICATION_VIEW_TABLE}
         where origin = :origin and sealed = false
         order by id, identity_id, source_key
         limit ${Math.floor(Math.min(batchSize, ARCHIVE_ROWS_PER_ENTRY))}
         for update`,
        { origin: NotificationViewOrigin.CARRIED },
        { wrappedConnection: connection }
      );
      if (!rows.length) return { rows: 0, done: true };
      await this.log.append(
        [
          entry({ type: 'notify-archive', v: 1, rows: rows.map(archivedRowOf) })
        ],
        { connection }
      );
      await this.db().execute(
        `update ${NOTIFICATION_VIEW_TABLE} set sealed = true
         where identity_id in (:identities) and source_key in (:keys)
           and origin = :origin`,
        {
          identities: Array.from(new Set(rows.map((row) => row.identity_id))),
          keys: rows.map((row) => row.source_key),
          origin: NotificationViewOrigin.CARRIED
        },
        { wrappedConnection: connection }
      );
      return { rows: rows.length, done: rows.length < batchSize };
    });
  }

  /**
   * Archives CARRIED rows the caller writes already sealed, in its
   * transaction, so a row an old writer adds in `on` is never missing from
   * a rebuild.
   */
  async archiveRows(
    rows: readonly Record<string, any>[],
    ctx: RequestContext
  ): Promise<void> {
    const entries: RecordLogEntry[] = [];
    for (let i = 0; i < rows.length; i += ARCHIVE_ROWS_PER_ENTRY) {
      entries.push(
        entry({
          type: 'notify-archive',
          v: 1,
          rows: rows.slice(i, i + ARCHIVE_ROWS_PER_ENTRY).map(archivedRowOf)
        })
      );
    }
    if (entries.length) await this.log.append(entries, ctx);
  }

  /** Records a delete of drops or waves, in the caller's transaction. */
  async recordDelete(
    reference: NotificationReference,
    values: readonly string[],
    ctx: RequestContext,
    carriedOnly = false
  ): Promise<void> {
    if (values.length) {
      await this.log.append(
        notifyDeleteEntries(reference, values, carriedOnly),
        ctx
      );
    }
  }

  /** Records a profile merge, in the caller's transaction. */
  async recordMerge(
    source: string,
    target: string,
    ctx: RequestContext
  ): Promise<void> {
    await this.log.append(
      [entry({ type: 'notify-merge', v: 1, source, target })],
      ctx
    );
  }

  /** Records a wave's new visibility group, in the caller's transaction. */
  async recordVisibility(
    waveId: string,
    visibilityGroupId: string | null,
    ctx: RequestContext
  ): Promise<void> {
    await this.log.append(
      [
        entry({
          type: 'notify-visibility',
          v: 1,
          wave_id: waveId,
          visibility_group_id: visibilityGroupId
        })
      ],
      ctx
    );
  }

  /**
   * Records each derived cause's windows (NOTIFY_DERIVED_CAUSES); run after
   * every change to them. A rebuild checks the flags against every entry.
   */
  async recordCuts(ctx: RequestContext): Promise<void> {
    await this.log.append(
      [
        entry({
          type: 'notify-cuts',
          v: 1,
          windows: loggedWindows(derivedCauseWindows())
        })
      ],
      ctx
    );
  }

  /**
   * Records a read mark made in `shadow` or `on`, in the caller's
   * transaction. A mark of many rows is split across entries.
   */
  async recordRead(
    receipt: NotificationReadReceipt,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const receipts: NotificationReadReceipt[] = [];
    if (receipt.scope === 'one') {
      receipts.push(receipt);
    } else {
      const keys = receipt.source_keys;
      for (let i = 0; i === 0 || i < keys.length; i += READ_KEYS_PER_ENTRY) {
        receipts.push({
          ...receipt,
          source_keys: keys.slice(i, i + READ_KEYS_PER_ENTRY)
        });
      }
    }
    await this.log.append(
      receipts.map((part) => entry({ type: 'notify-read', v: 1, ...part })),
      { connection }
    );
  }
}

/** Inserts archived rows as sealed CARRIED rows; inserting twice is harmless. */
export async function restoreArchivedRows(
  db: SqlExecutor,
  rows: readonly ArchivedNotificationRow[],
  connection: ConnectionWrapper<any>
): Promise<void> {
  if (!rows.length) return;
  await db.bulkUpsert(
    NOTIFICATION_VIEW_TABLE,
    rows.map((row) => {
      const sourceRef = String(row.legacy_id);
      const sourceKey = notificationSourceKey(
        CARRIED_FAMILY,
        sourceRef,
        row.identity_id
      );
      // The id must be the one the archive kept: an old id, or a time id.
      if (
        row.id > 2 ** 40 &&
        row.id !== notificationViewId(row.created_at, sourceKey)
      ) {
        throw new Error(`Archived notification ${row.id} has a foreign id`);
      }
      return {
        ...row,
        additional_data: JSON.stringify(row.additional_data),
        source_key: sourceKey,
        source_family: CARRIED_FAMILY,
        source_ref: sourceRef,
        origin: NotificationViewOrigin.CARRIED,
        sealed: true
      };
    }),
    [
      'identity_id',
      'source_key',
      'id',
      'source_family',
      'source_ref',
      'origin',
      'legacy_id',
      'additional_identity_id',
      'related_drop_id',
      'related_drop_part_no',
      'related_drop_2_id',
      'related_drop_2_part_no',
      'cause',
      'additional_data',
      'created_at',
      'read_at',
      'visibility_group_id',
      'wave_id',
      'sealed'
    ],
    [],
    undefined,
    { connection }
  );
}

/** Applies one read mark to the view, as the route did when it was made. */
export async function applyReadReceipt(
  db: SqlExecutor,
  receipt: NotificationReadReceipt,
  connection: ConnectionWrapper<any>
): Promise<void> {
  const options = { wrappedConnection: connection };
  if (receipt.scope === 'one') {
    await db.execute(
      `update ${NOTIFICATION_VIEW_TABLE} set read_at = :read_at
       where identity_id = :identity_id and (id = :id or legacy_id = :id)`,
      receipt,
      options
    );
    return;
  }
  // A mark-all or mark-wave read the rows it lists, the unread rows when it
  // was made; a row derived later, even for an earlier time, stays unread.
  for (let i = 0; i < receipt.source_keys.length; i += READ_KEY_CHUNK) {
    await db.execute(
      `update ${NOTIFICATION_VIEW_TABLE} set read_at = :read_at
       where identity_id = :identity_id and read_at is null
         and source_key in (:keys)`,
      {
        identity_id: receipt.identity_id,
        read_at: receipt.read_at,
        keys: receipt.source_keys.slice(i, i + READ_KEY_CHUNK)
      },
      options
    );
  }
}

const READ_KEY_CHUNK = 1000;

/** Applies a logged delete: the rows naming those drops or waves go. */
export async function applyDelete(
  db: SqlExecutor,
  body: {
    reference: NotificationReference;
    values: readonly string[];
    carried_only: boolean;
  },
  connection: ConnectionWrapper<any>
): Promise<void> {
  if (!body.values.length) return;
  await db.execute(
    `delete from ${NOTIFICATION_VIEW_TABLE} where ${deletedRowsPredicate(body.reference)}${
      body.carried_only
        ? ` and origin = '${NotificationViewOrigin.CARRIED}'`
        : ''
    }`,
    { values: body.values },
    { wrappedConnection: connection }
  );
}

/** Applies a logged wave visibility change to the wave's rows. */
export async function applyVisibility(
  db: SqlExecutor,
  waveId: string,
  visibilityGroupId: string | null,
  connection: ConnectionWrapper<any>
): Promise<void> {
  await db.execute(
    `update ${NOTIFICATION_VIEW_TABLE} set visibility_group_id = :visibilityGroupId
     where wave_id = :waveId`,
    { waveId, visibilityGroupId },
    { wrappedConnection: connection }
  );
}

export const notificationArchive = new NotificationArchive(
  dbSupplier,
  new RecordLogWriter(recordLogDb, deviceGrantProofSource)
);
