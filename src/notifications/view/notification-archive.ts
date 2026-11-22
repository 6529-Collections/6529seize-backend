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
import { derivedCauseCuts } from '@/notifications/view/notify-view-flags';

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
    }
  | {
      readonly scope: 'wave';
      readonly identity_id: string;
      readonly wave_id: string;
      readonly read_at: number;
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
      readonly cuts: Record<string, number>;
    }
  | ({ readonly type: 'notify-read'; readonly v: 1 } & NotificationReadReceipt);

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
 * Writes what the notification view cannot derive into the private record
 * log, where 6529.io's service identity seals, pins and archives it: the
 * CARRIED rows (copies of identity_notifications rows from before their
 * cause was derived), the cuts in force, and the read marks people make.
 * A rebuild reads them back (NotificationViewRebuild).
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
          entry({
            type: 'notify-archive',
            v: 1,
            rows: rows.map((row) => ({
              identity_id: row.identity_id,
              id: Number(row.id),
              legacy_id: Number(row.legacy_id),
              cause: row.cause,
              additional_identity_id: row.additional_identity_id,
              related_drop_id: row.related_drop_id,
              related_drop_part_no: toNumberOrNull(row.related_drop_part_no),
              related_drop_2_id: row.related_drop_2_id,
              related_drop_2_part_no: toNumberOrNull(
                row.related_drop_2_part_no
              ),
              additional_data:
                typeof row.additional_data === 'string'
                  ? JSON.parse(row.additional_data)
                  : row.additional_data,
              created_at: Number(row.created_at),
              read_at: toNumberOrNull(row.read_at),
              visibility_group_id: row.visibility_group_id,
              wave_id: row.wave_id
            }))
          })
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

  /** Records the cuts in force (NOTIFY_DERIVED_CAUSES); a rebuild checks them. */
  async recordCuts(ctx: RequestContext): Promise<void> {
    await this.log.append(
      [
        entry({
          type: 'notify-cuts',
          v: 1,
          cuts: Object.fromEntries(derivedCauseCuts())
        })
      ],
      ctx
    );
  }

  /** Records a read mark made in `on` mode, in the caller's transaction. */
  async recordRead(
    receipt: NotificationReadReceipt,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    await this.log.append([entry({ type: 'notify-read', v: 1, ...receipt })], {
      connection
    });
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
  // A mark-all or mark-wave read everything that existed when it was made.
  await db.execute(
    `update ${NOTIFICATION_VIEW_TABLE} set read_at = :read_at
     where identity_id = :identity_id and read_at is null
       and created_at <= :read_at${receipt.scope === 'wave' ? ' and wave_id = :wave_id' : ''}`,
    receipt,
    options
  );
}

export const notificationArchive = new NotificationArchive(
  dbSupplier,
  new RecordLogWriter(recordLogDb, deviceGrantProofSource)
);
