import {
  NOTIFICATION_VIEW_PUSH_OUTBOX_TABLE,
  NOTIFICATION_VIEW_TABLE
} from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { OUTBOX_BATCH_SIZE } from '@/notifications/push-notification-outbox.db';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { Time } from '@/time';

/**
 * A notification_view row's key. View ids repeat across people (two
 * recipients of one drop share its millisecond), so a queued push names its
 * row by this key, not by id.
 */
export interface ViewNotificationKey {
  readonly identity_id: string;
  readonly source_key: string;
}

/** A view row with the columns the push worker reads from identity_notifications. */
export interface ViewPushRow extends ViewNotificationKey {
  readonly id: number;
  readonly legacy_id: number | null;
  readonly additional_identity_id: string | null;
  readonly related_drop_id: string | null;
  readonly related_drop_part_no: number | null;
  readonly related_drop_2_id: string | null;
  readonly related_drop_2_part_no: number | null;
  readonly cause: IdentityNotificationCause;
  readonly additional_data: Record<string, unknown>;
  readonly created_at: number;
  readonly read_at: number | null;
  readonly visibility_group_id: string | null;
  readonly wave_id: string | null;
}

const READ_COLUMNS = [
  'identity_id',
  'source_key',
  'id',
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
  'wave_id'
].join(', ');

const KEY_CHUNK = 500;

const toNumberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** `(identity_id, source_key)` equals one of the keys, as named parameters. */
function keyPredicate(
  keys: readonly ViewNotificationKey[],
  params: Record<string, string>
): string {
  return keys
    .map((key, index) => {
      params[`identity_${index}`] = key.identity_id;
      params[`source_${index}`] = key.source_key;
      return `(identity_id = :identity_${index} and source_key = :source_${index})`;
    })
    .join(' or ');
}

function toPushRow(row: Record<string, any>): ViewPushRow {
  return {
    identity_id: row.identity_id,
    source_key: row.source_key,
    id: Number(row.id),
    legacy_id: toNumberOrNull(row.legacy_id),
    additional_identity_id: row.additional_identity_id,
    related_drop_id: row.related_drop_id,
    related_drop_part_no: toNumberOrNull(row.related_drop_part_no),
    related_drop_2_id: row.related_drop_2_id,
    related_drop_2_part_no: toNumberOrNull(row.related_drop_2_part_no),
    cause: row.cause,
    additional_data:
      typeof row.additional_data === 'string'
        ? JSON.parse(row.additional_data)
        : (row.additional_data ?? {}),
    created_at: Number(row.created_at),
    read_at: toNumberOrNull(row.read_at),
    visibility_group_id: row.visibility_group_id,
    wave_id: row.wave_id
  };
}

/**
 * Pushes of notification_view rows. The deriver queues a row in the
 * transaction that writes it (notification_view_push_outbox), the scheduled
 * publisher moves queued keys to SQS as push_notification_outbox_entries'
 * ids are moved, and the push worker reads each row back from the view.
 */
export class NotificationViewPushDb extends LazyDbAccessCompatibleService {
  /** Queues pushes in the caller's transaction; a key already queued is queued once. */
  async enqueue(
    keys: readonly ViewNotificationKey[],
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    if (!keys.length) return;
    const now = Time.currentMillis();
    await this.db.bulkInsert(
      NOTIFICATION_VIEW_PUSH_OUTBOX_TABLE,
      keys.map((key) => ({
        identity_id: key.identity_id,
        source_key: key.source_key,
        created_at: now
      })),
      ['identity_id', 'source_key', 'created_at'],
      undefined,
      { connection, ignoreDuplicates: true }
    );
  }

  async oldestPendingAt(): Promise<number | null> {
    const row = await this.db.oneOrNull<{ created_at: number | null }>(
      `select min(created_at) as created_at from ${NOTIFICATION_VIEW_PUSH_OUTBOX_TABLE}`,
      undefined,
      { forcePool: DbPoolName.WRITE }
    );
    return row?.created_at == null ? null : Number(row.created_at);
  }

  /** Keys leave the queue only after SQS accepts their batch, as in the old outbox. */
  async publishBatch(
    send: (keys: ViewNotificationKey[]) => Promise<void>
  ): Promise<number> {
    return this.db.executeNativeQueriesInTransaction(
      async (connection) => {
        const rows = await this.db.execute<ViewNotificationKey>(
          `select identity_id, source_key from ${NOTIFICATION_VIEW_PUSH_OUTBOX_TABLE}
           order by created_at, identity_id, source_key
           limit ${OUTBOX_BATCH_SIZE} for update skip locked`,
          undefined,
          { wrappedConnection: connection }
        );
        if (!rows.length) return 0;
        const keys = rows.map((row) => ({
          identity_id: row.identity_id,
          source_key: row.source_key
        }));
        await send(keys);
        const params: Record<string, string> = {};
        await this.db.execute(
          `delete from ${NOTIFICATION_VIEW_PUSH_OUTBOX_TABLE} where ${keyPredicate(keys, params)}`,
          params,
          { wrappedConnection: connection }
        );
        return keys.length;
      },
      { isolationLevel: 'READ COMMITTED' }
    );
  }

  /**
   * The rows queued pushes name, from the writer: a row queued with its
   * write and missing there now was removed since.
   */
  async findRows(keys: readonly ViewNotificationKey[]): Promise<ViewPushRow[]> {
    const found: ViewPushRow[] = [];
    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      const params: Record<string, string> = {};
      const predicate = keyPredicate(keys.slice(i, i + KEY_CHUNK), params);
      const rows = await this.db.execute<Record<string, any>>(
        `select ${READ_COLUMNS} from ${NOTIFICATION_VIEW_TABLE} where ${predicate}`,
        params,
        { forcePool: DbPoolName.WRITE }
      );
      found.push(...rows.map(toPushRow));
    }
    return found;
  }

  /** The view rows of identity_notifications rows, by the old rows' ids. */
  async findRowsByLegacyIds(ids: readonly number[]): Promise<ViewPushRow[]> {
    if (!ids.length) return [];
    const rows = await this.db.execute<Record<string, any>>(
      `select ${READ_COLUMNS} from ${NOTIFICATION_VIEW_TABLE} where legacy_id in (:ids)`,
      { ids },
      { forcePool: DbPoolName.WRITE }
    );
    return rows.map(toPushRow);
  }
}

export const notificationViewPushDb = new NotificationViewPushDb(dbSupplier);
