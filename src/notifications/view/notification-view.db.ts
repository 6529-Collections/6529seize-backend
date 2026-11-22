import { NOTIFICATION_VIEW_TABLE } from '@/constants';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { NotificationViewOrigin } from '@/entities/INotificationView';
import {
  notificationSourceKey,
  notificationViewId
} from '@/notifications/view/notification-view-ids';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

/** A notification_view row as the deriver writes it. */
export interface NotificationViewRow {
  readonly identity_id: string;
  readonly source_key: string;
  readonly id: number;
  readonly source_family: string;
  readonly source_ref: string;
  readonly origin: NotificationViewOrigin;
  readonly additional_identity_id: string | null;
  readonly related_drop_id: string | null;
  readonly related_drop_part_no: number | null;
  readonly related_drop_2_id: string | null;
  readonly related_drop_2_part_no: number | null;
  readonly cause: IdentityNotificationCause;
  /** JSON text. */
  readonly additional_data: string;
  readonly created_at: number;
  readonly visibility_group_id: string | null;
  readonly wave_id: string | null;
}

/** What the deriver needs to know about a group's current rows. */
export interface StoredViewRow extends NotificationViewRow {
  readonly legacy_id: number | null;
}

const WRITE_COLUMNS = [
  'identity_id',
  'source_key',
  'id',
  'source_family',
  'source_ref',
  'origin',
  'additional_identity_id',
  'related_drop_id',
  'related_drop_part_no',
  'related_drop_2_id',
  'related_drop_2_part_no',
  'cause',
  'additional_data',
  'created_at',
  'visibility_group_id',
  'wave_id'
] as const;

/** A re-derived row keeps its read state and its copy's id. */
const UPDATE_COLUMNS = WRITE_COLUMNS.filter(
  (column) => column !== 'identity_id' && column !== 'source_key'
);

/** The family of rows copied from identity_notifications. */
export const CARRIED_FAMILY = 'carried';

/** An identity_notifications row as its writer serialized it, with its id. */
export interface CarriedNotificationRow {
  readonly legacy_id: number;
  readonly identity_id: string;
  readonly additional_identity_id: string | null;
  readonly related_drop_id: string | null;
  readonly related_drop_part_no: number | null;
  readonly related_drop_2_id: string | null;
  readonly related_drop_2_part_no: number | null;
  readonly cause: IdentityNotificationCause;
  /** JSON text. */
  readonly additional_data: string;
  readonly created_at: number;
  readonly visibility_group_id: string | null;
  readonly wave_id: string | null;
}

const LEGACY_ID_CHUNK = 500;

const toNumberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export class NotificationViewDb extends LazyDbAccessCompatibleService {
  /** The group's rows, locked for the deriver's transaction. */
  async findGroupForUpdate(
    family: string,
    ref: string,
    connection: ConnectionWrapper<any>
  ): Promise<StoredViewRow[]> {
    const rows = await this.db.execute<StoredViewRow>(
      `select ${WRITE_COLUMNS.join(', ')}, legacy_id
       from ${NOTIFICATION_VIEW_TABLE}
       where source_family = :family and source_ref = :ref
       order by identity_id, source_key
       for update`,
      { family, ref },
      { wrappedConnection: connection }
    );
    return rows.map((row) => ({
      ...row,
      id: Number(row.id),
      created_at: Number(row.created_at),
      legacy_id: toNumberOrNull(row.legacy_id),
      related_drop_part_no: toNumberOrNull(row.related_drop_part_no),
      related_drop_2_part_no: toNumberOrNull(row.related_drop_2_part_no),
      additional_data:
        typeof row.additional_data === 'string'
          ? row.additional_data
          : JSON.stringify(row.additional_data)
    }));
  }

  async upsertRows(
    rows: readonly NotificationViewRow[],
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    if (!rows.length) return;
    await this.db.bulkUpsert(
      NOTIFICATION_VIEW_TABLE,
      [...rows],
      [...WRITE_COLUMNS],
      [...UPDATE_COLUMNS],
      undefined,
      { connection }
    );
  }

  /**
   * Copies rows an old writer just wrote into identity_notifications, for a
   * cause that is not derived yet. A copy's id follows its time, as derived
   * ids do; it keeps the original id as legacy_id. Copying twice is harmless.
   */
  async insertCarried(
    rows: readonly CarriedNotificationRow[],
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    if (!rows.length) return;
    const viewRows = rows.map((row) => {
      const sourceRef = String(row.legacy_id);
      const sourceKey = notificationSourceKey(
        CARRIED_FAMILY,
        sourceRef,
        row.identity_id
      );
      return {
        ...row,
        source_key: sourceKey,
        id: notificationViewId(row.created_at, sourceKey),
        source_family: CARRIED_FAMILY,
        source_ref: sourceRef,
        origin: NotificationViewOrigin.CARRIED
      };
    });
    await this.db.bulkUpsert(
      NOTIFICATION_VIEW_TABLE,
      viewRows,
      [...WRITE_COLUMNS, 'legacy_id'],
      [],
      undefined,
      { connection }
    );
  }

  async deleteRows(
    keys: readonly { identity_id: string; source_key: string }[],
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    for (let i = 0; i < keys.length; i += LEGACY_ID_CHUNK) {
      const chunk = keys.slice(i, i + LEGACY_ID_CHUNK);
      const params: Record<string, string> = {};
      const pairs = chunk.map((key, index) => {
        params[`identity_${index}`] = key.identity_id;
        params[`source_${index}`] = key.source_key;
        return `(identity_id = :identity_${index} and source_key = :source_${index})`;
      });
      await this.db.execute(
        `delete from ${NOTIFICATION_VIEW_TABLE} where ${pairs.join(' or ')}`,
        params,
        { wrappedConnection: connection }
      );
    }
  }

  /** Records the identity_notifications copy of each row, in one statement per chunk. */
  async setLegacyIds(
    keys: readonly {
      identity_id: string;
      source_key: string;
      legacy_id: number;
    }[],
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    for (let i = 0; i < keys.length; i += LEGACY_ID_CHUNK) {
      const chunk = keys.slice(i, i + LEGACY_ID_CHUNK);
      const params: Record<string, string | number> = {};
      const rows = chunk.map((key, index) => {
        params[`identity_${index}`] = key.identity_id;
        params[`source_${index}`] = key.source_key;
        params[`legacy_${index}`] = key.legacy_id;
        return `select :identity_${index} as identity_id, :source_${index} as source_key, :legacy_${index} as legacy_id`;
      });
      await this.db.execute(
        `update ${NOTIFICATION_VIEW_TABLE} v
         join (${rows.join(' union all ')}) copies
           on copies.identity_id = v.identity_id
          and copies.source_key = v.source_key
         set v.legacy_id = copies.legacy_id`,
        params,
        { wrappedConnection: connection }
      );
    }
  }
}

export const notificationViewDb = new NotificationViewDb(dbSupplier);
