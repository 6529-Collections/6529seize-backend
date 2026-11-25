import { artistArtworkNotificationVisibleSql } from './artist-artwork-submission.db';
import { DbPoolName } from '@/db-query.options';
import { optionalWaveReadAccessSql } from '@/waves/wave-read-access-sql';
import {
  ViewerGroupsCte,
  viewerGroupsCteSupported
} from '@/waves/viewer-groups-cte';
import { viewerGroupSets } from '@/waves/viewer-group-sets';
import { legacyGetView } from '@/competitions/legacy-competition-get-facade';
import { isActivated } from '@/api/push-notifications/push-notifications.service';
import { PushNotificationOutboxDb } from '@/notifications/push-notification-outbox.db';
import {
  IDENTITIES_TABLE,
  CONTENT_MODERATION_DROP_STATES_TABLE,
  CONTENT_MODERATION_PROFILE_BLOCKS_TABLE,
  DROPS_TABLE,
  IDENTITY_MUTES_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  NOTIFICATION_VIEW_TABLE,
  PUSH_NOTIFICATION_CANCELLATIONS_TABLE,
  WAVE_READER_METRICS_TABLE,
  WAVES_TABLE
} from '@/constants';
import {
  isDerivedCause,
  legacyOutputEnabled,
  notificationsReadTable,
  notifyViewMode
} from '@/notifications/view/notify-view-flags';
import type { DerivedNotification } from '@/notifications/view/derived-notification';
import {
  notificationSourceKey,
  notificationViewId
} from '@/notifications/view/notification-view-ids';
import { notificationViewDb } from '@/notifications/view/notification-view.db';
import { notificationArchive } from '@/notifications/view/notification-archive';
import {
  IdentityNotificationCause,
  IdentityNotificationEntity
} from '../entities/IIdentityNotification';
import { Logger } from '../logging';
import { numbers } from '../numbers';
import { RequestContext } from '../request.context';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '../sql-executor';
import { Time } from '../time';
import {
  identityMutesDb as defaultIdentityMutesDb,
  IdentityMutesDb
} from '@/api/identity-mutes/identity-mutes.db';
import {
  contentModerationDb as defaultContentModerationDb,
  ContentModerationDb
} from '@/content-moderation/content-moderation.db';
import { DropModerationStatus } from '@/entities/IContentModeration';
import {
  profilePreferencesDb as defaultProfilePreferencesDb,
  ProfilePreferencesDb
} from '@/profile-preferences/profile-preferences.db';
import { isNotificationEnabled } from '@/profile-preferences/profile-notification-policy';
import { DEFAULT_PROFILE_PREFERENCES } from '@/entities/IProfilePreferences';
import { anonymousNotificationActorSql } from '@/notifications/anonymous-notification-actor';

type SerializableNotificationInsertRow = Record<string, string | number | null>;

/** Rows per bulk insert of derived copies; an @all never writes row by row. */
const DERIVED_COPY_CHUNK = 500;
/** View rows re-keyed per statement in a merge. */
const VIEW_MOVE_CHUNK = 500;

// Keep existing status-change notices out of both the feed and its unread count.
const COMPETITION_NOTIFICATION_VISIBILITY_SQL = `(
  n.cause <> '${IdentityNotificationCause.COMPETITION_LIFECYCLE}'
  OR JSON_UNQUOTE(JSON_EXTRACT(n.additional_data, '$.event_type')) IN (
    'COMPETITION_DECISION_COMPLETED'
  )
)`;

const IDENTITY_NOTIFICATION_INSERT_COLUMNS = [
  'identity_id',
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

export class IdentityNotificationsDb extends LazyDbAccessCompatibleService {
  private readonly logger = Logger.get(IdentityNotificationsDb.name);

  constructor(
    dbSupplier: () => SqlExecutor,
    private readonly identityMutesDb: Pick<
      IdentityMutesDb,
      'filterMutedNotificationRows'
    > = defaultIdentityMutesDb,
    private readonly contentModerationDb: Pick<
      ContentModerationDb,
      'filterBlockedNotificationRows' | 'filterUnavailableDropNotificationRows'
    > = defaultContentModerationDb,
    private readonly profilePreferencesDb: Pick<
      ProfilePreferencesDb,
      'getMany'
    > = defaultProfilePreferencesDb
  ) {
    super(dbSupplier);
  }

  public async countMentionRecipients(
    identityIds: string[],
    authorId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<number> {
    const rows = await this.filterNotificationRowsForWrite(
      Array.from(new Set(identityIds)).map((identityId) => ({
        identity_id: identityId,
        additional_identity_id: authorId,
        cause: IdentityNotificationCause.IDENTITY_MENTIONED,
        related_drop_id: null,
        related_drop_part_no: null,
        related_drop_2_id: null,
        related_drop_2_part_no: null,
        wave_id: null,
        visibility_group_id: null,
        additional_data: {}
      })),
      connection
    );
    return rows.length;
  }

  private isNotifierActivated() {
    return process.env.USER_NOTIFIER_ACTIVATED === 'true';
  }

  async insertNotification(
    notification: NewIdentityNotification,
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    // A derived cause comes from the deriver only (NOTIFY_DERIVED_CAUSES).
    if (isDerivedCause(notification.cause)) return;
    if (!connection && this.isNotifierActivated()) {
      return this.db.executeNativeQueriesInTransaction((transaction) =>
        this.insertNotification(notification, transaction)
      );
    }
    if (this.isNotifierActivated()) {
      const [filteredNotification] = await this.filterNotificationRowsForWrite(
        [notification],
        connection
      );
      if (!filteredNotification) {
        return;
      }

      const row = this.serializeNotificationInsertRow(
        filteredNotification,
        Time.currentMillis()
      );
      const notificationId = await this.insertNotificationRow(row, connection);

      if (notificationId) {
        await this.carryIntoView([row], [notificationId], connection);
        if (isActivated()) {
          await new PushNotificationOutboxDb(() => this.db).enqueue(
            notificationId,
            { connection }
          );
        }
      } else {
        this.logger.error('No notification id returned from insert');
      }
    }
  }

  async insertManyNotifications(
    allNotifications: NewIdentityNotification[],
    connection?: ConnectionWrapper<any>
  ): Promise<number[]> {
    // A derived cause comes from the deriver only (NOTIFY_DERIVED_CAUSES).
    const notifications = allNotifications.filter(
      (notification) => !isDerivedCause(notification.cause)
    );
    if (!this.isNotifierActivated() || !notifications.length) {
      return [];
    }

    if (connection) {
      return this.insertManyNotificationsWithConnection(
        notifications,
        connection
      );
    }

    return this.executeNativeQueriesInTransaction((wrappedConnection) =>
      this.insertManyNotificationsWithConnection(
        notifications,
        wrappedConnection
      )
    );
  }

  private async insertManyNotificationsWithConnection(
    notifications: NewIdentityNotification[],
    connection: ConnectionWrapper<any>
  ): Promise<number[]> {
    const unmutedNotifications = await this.filterNotificationRowsForWrite(
      notifications,
      connection
    );
    const insertedIds: number[] = [];
    const chunkSize = 1000;
    for (let i = 0; i < unmutedNotifications.length; i += chunkSize) {
      const chunk = unmutedNotifications.slice(i, i + chunkSize);
      const createdAt = Time.currentMillis();
      const rows = chunk.map((notification) =>
        this.serializeNotificationInsertRow(notification, createdAt)
      );
      await this.db.bulkInsert(
        IDENTITY_NOTIFICATIONS_TABLE,
        rows,
        [...IDENTITY_NOTIFICATION_INSERT_COLUMNS],
        undefined,
        { connection }
      );
      const firstInsertId = await this.getLastInsertId(connection);
      const chunkIds = await this.findInsertedNotificationIds(
        rows,
        firstInsertId,
        connection
      );
      if (chunkIds.length === rows.length) {
        await this.carryIntoView(rows, chunkIds, connection);
      } else {
        this.logger.error(
          `Expected ${rows.length} inserted notification ids, found ${chunkIds.length}`
        );
      }
      insertedIds.push(...chunkIds);
    }

    return insertedIds;
  }

  /**
   * In `on` mode the readers use notification_view, so a row an old writer
   * adds for a cause that is not derived yet is copied there too.
   */
  private async carryIntoView(
    rows: readonly SerializableNotificationInsertRow[],
    ids: readonly number[],
    connection?: ConnectionWrapper<any>
  ): Promise<void> {
    if (notifyViewMode() !== 'on' || !connection) return;
    // Archived as it is written, so a rebuild never misses a CARRIED row
    // added after the switch's sealing.
    const carried = await notificationViewDb.insertCarried(
      rows.map((row, index) => ({
        legacy_id: ids[index],
        identity_id: String(row.identity_id),
        additional_identity_id: row.additional_identity_id as string | null,
        related_drop_id: row.related_drop_id as string | null,
        related_drop_part_no: row.related_drop_part_no as number | null,
        related_drop_2_id: row.related_drop_2_id as string | null,
        related_drop_2_part_no: row.related_drop_2_part_no as number | null,
        cause: row.cause as IdentityNotificationCause,
        additional_data: String(row.additional_data),
        created_at: Number(row.created_at),
        visibility_group_id: row.visibility_group_id as string | null,
        wave_id: row.wave_id as string | null
      })),
      connection,
      { sealed: true }
    );
    await notificationArchive.archiveRows(
      carried.map((row) => ({ ...row, read_at: null })),
      { connection }
    );
  }

  /**
   * Today's write filters (mutes, blocks, hidden drops and preferences),
   * which the deriver applies to its identity_notifications copies and
   * pushes when a row first appears.
   */
  async filterDerivedRowsForWrite<T extends NewIdentityNotification>(
    notifications: T[],
    connection: ConnectionWrapper<any>
  ): Promise<T[]> {
    if (!notifications.length) return [];
    return this.filterNotificationRowsForWrite(notifications, connection);
  }

  /**
   * Writes the deriver's rows into identity_notifications, keeping their
   * times, and returns the new ids in input order. Rows are already
   * filtered; this skips the gate that keeps old writers off derived causes.
   */
  async insertDerivedCopies(
    rows: readonly DerivedNotification[],
    connection: ConnectionWrapper<any>
  ): Promise<number[]> {
    if (new Set(rows.map((row) => row.identity_id)).size !== rows.length) {
      throw new Error('Derived copies must have one row per recipient');
    }
    const ids: number[] = [];
    for (let i = 0; i < rows.length; i += DERIVED_COPY_CHUNK) {
      const chunk = rows.slice(i, i + DERIVED_COPY_CHUNK);
      const serialized = chunk.map((row) =>
        this.serializeNotificationInsertRow(row, row.created_at)
      );
      await this.db.bulkInsert(
        IDENTITY_NOTIFICATIONS_TABLE,
        serialized,
        [...IDENTITY_NOTIFICATION_INSERT_COLUMNS],
        undefined,
        { connection }
      );
      const firstInsertId = await this.getLastInsertId(connection);
      // The first match from this insert's id is ours; ids only grow.
      const inserted = new Map<string, number>();
      for (const row of await this.findInsertedNotificationRows(
        serialized,
        firstInsertId,
        connection
      )) {
        if (!inserted.has(row.identity_id)) {
          inserted.set(row.identity_id, row.id);
        }
      }
      for (const row of chunk) {
        const id = inserted.get(row.identity_id);
        if (id === undefined) {
          throw new Error('A derived copy was not found after its insert');
        }
        ids.push(id);
      }
    }
    return ids;
  }

  /** Brings a derived copy in line with its re-derived row, keeping read state. */
  async updateDerivedCopy(
    id: number,
    row: DerivedNotification,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const serialized = this.serializeNotificationInsertRow(row, row.created_at);
    await this.db.execute(
      `update ${IDENTITY_NOTIFICATIONS_TABLE}
       set ${IDENTITY_NOTIFICATION_INSERT_COLUMNS.map((column) => `\`${column}\` = :${column}`).join(', ')}
       where id = :id`,
      { ...serialized, id },
      { wrappedConnection: connection }
    );
  }

  /** Removes derived copies a re-derivation dropped; a queued push is cancelled. */
  async deleteDerivedCopies(
    ids: readonly number[],
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    if (!ids.length) return;
    const options = { wrappedConnection: connection };
    await this.db.execute(
      `insert into ${PUSH_NOTIFICATION_CANCELLATIONS_TABLE} (notification_id, cancelled_at)
       select id, :now from ${IDENTITY_NOTIFICATIONS_TABLE} where id in (:ids)
       on duplicate key update cancelled_at = values(cancelled_at)`,
      { ids, now: Time.currentMillis() },
      options
    );
    await this.db.execute(
      `delete from ${IDENTITY_NOTIFICATIONS_TABLE} where id in (:ids)`,
      { ids },
      options
    );
  }

  private async filterMutedNotificationRowsForWrite<
    T extends {
      readonly identity_id: string;
      readonly additional_identity_id: string | null;
    }
  >(notifications: T[], connection?: ConnectionWrapper<any>): Promise<T[]> {
    try {
      return await this.identityMutesDb.filterMutedNotificationRows(
        notifications,
        connection,
        { allowPendingCompetitionEntry: true }
      );
    } catch (error) {
      this.logger.error(
        'Failed to filter muted notification rows; inserting unfiltered notifications',
        error
      );
      return notifications;
    }
  }

  private async filterNotificationRowsForWrite<
    T extends NewIdentityNotification
  >(notifications: T[], connection?: ConnectionWrapper<any>): Promise<T[]> {
    const unmuted = await this.filterMutedNotificationRowsForWrite(
      notifications,
      connection
    );
    if (!unmuted.length) return [];
    let available: T[];
    try {
      const unblocked =
        await this.contentModerationDb.filterBlockedNotificationRows(
          unmuted,
          connection,
          { allowPendingCompetitionEntry: true }
        );
      available =
        await this.contentModerationDb.filterUnavailableDropNotificationRows(
          unblocked,
          connection
        );
    } catch (error) {
      this.logger.error(
        'Failed to apply content moderation on notification write',
        error
      );
      throw error;
    }
    if (!available.length) return [];
    try {
      const preferences = await this.profilePreferencesDb.getMany(
        Array.from(
          new Set(available.map((notification) => notification.identity_id))
        ),
        connection
      );
      return available.filter((notification) =>
        isNotificationEnabled(
          notification.cause,
          preferences.get(notification.identity_id) ??
            DEFAULT_PROFILE_PREFERENCES
        )
      );
    } catch (error) {
      this.logger.error(
        'Failed to filter notification rows by profile preferences; inserting unfiltered notifications',
        error
      );
      return available;
    }
  }

  private serializeNotificationInsertRow(
    notification: NewIdentityNotification,
    createdAt: number
  ): SerializableNotificationInsertRow {
    return {
      identity_id: notification.identity_id,
      additional_identity_id: notification.additional_identity_id,
      related_drop_id: notification.related_drop_id,
      related_drop_part_no: notification.related_drop_part_no,
      related_drop_2_id: notification.related_drop_2_id,
      related_drop_2_part_no: notification.related_drop_2_part_no,
      cause: notification.cause,
      additional_data: JSON.stringify(notification.additional_data),
      created_at: createdAt,
      visibility_group_id: notification.visibility_group_id,
      wave_id: notification.wave_id
    };
  }

  private async insertNotificationRow(
    row: SerializableNotificationInsertRow,
    connection?: ConnectionWrapper<any>
  ): Promise<number | null> {
    const result = await this.db.execute(
      `
        insert into ${IDENTITY_NOTIFICATIONS_TABLE} (
          ${IDENTITY_NOTIFICATION_INSERT_COLUMNS.map((column) => `\`${column}\``).join(', ')}
        ) values (
          ${IDENTITY_NOTIFICATION_INSERT_COLUMNS.map((column) => `:${column}`).join(', ')}
        )
      `,
      row,
      connection ? { wrappedConnection: connection } : undefined
    );
    return this.extractInsertId(result);
  }

  private async findInsertedNotificationIds(
    rows: SerializableNotificationInsertRow[],
    firstInsertId: number,
    connection: ConnectionWrapper<any>
  ): Promise<number[]> {
    return (
      await this.findInsertedNotificationRows(rows, firstInsertId, connection)
    ).map((row) => row.id);
  }

  /** The rows a bulk insert just wrote, matched on every inserted column. */
  private async findInsertedNotificationRows(
    rows: SerializableNotificationInsertRow[],
    firstInsertId: number,
    connection: ConnectionWrapper<any>
  ): Promise<{ id: number; identity_id: string }[]> {
    const params: Record<string, string | number | null> = {
      firstInsertId
    };
    const rowClauses = rows.map((row, rowIndex) => {
      const columnClauses = IDENTITY_NOTIFICATION_INSERT_COLUMNS.map(
        (column) => {
          const paramName = `${column}_${rowIndex}`;
          params[paramName] = row[column];
          if (column === 'additional_data') {
            return `\`${column}\` <=> CAST(:${paramName} AS JSON)`;
          }
          return `\`${column}\` <=> :${paramName}`;
        }
      );
      return `(${columnClauses.join(' AND ')})`;
    });

    const insertedRows = await this.db.execute<{
      id: number;
      identity_id: string;
    }>(
      `
        select id, identity_id
        from ${IDENTITY_NOTIFICATIONS_TABLE}
        where id >= :firstInsertId
          and (${rowClauses.join(' OR ')})
        order by id asc
      `,
      params,
      { wrappedConnection: connection }
    );
    return insertedRows.map((row) => ({
      id: Number(row.id),
      identity_id: row.identity_id
    }));
  }

  private extractInsertId(result: any): number | null {
    const candidates = Array.isArray(result)
      ? [result[2], result[0]?.insertId, result[0]?.id]
      : [result?.insertId, result?.id];
    for (const candidate of candidates) {
      const parsed = Number(candidate);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
    return null;
  }

  async updateNotificationReadAt(
    {
      id,
      identity_id,
      readAt
    }: { id: number; identity_id: string; readAt: number | null },
    connection?: ConnectionWrapper<any>
  ) {
    const params = { id, identity_id, read_at: readAt };
    const options = connection ? { wrappedConnection: connection } : undefined;
    const mode = notifyViewMode();
    if (mode === 'off') {
      await this.db.execute(
        `
        update ${IDENTITY_NOTIFICATIONS_TABLE}
        set read_at = :read_at
        where
          id = :id
          and identity_id = :identity_id
      `,
        params,
        options
      );
      return;
    }
    if (!connection) {
      await this.db.executeNativeQueriesInTransaction((transaction) =>
        this.updateNotificationReadAt({ id, identity_id, readAt }, transaction)
      );
      return;
    }
    // The view answers by its own id or, for a client that holds one (every
    // client in `shadow`), by the identity_notifications id of its copy. Ids
    // of the two tables never overlap. The archive keeps the mark by view
    // id, so a rebuild applies it; in `shadow` that covers the deriver's rows
    // that will stand at the switch.
    const viewRows = await this.db.execute<{ id: number }>(
      `select id from ${NOTIFICATION_VIEW_TABLE}
       where identity_id = :identity_id and (id = :id or legacy_id = :id)
       for update`,
      params,
      options
    );
    await this.db.execute(
      `update ${NOTIFICATION_VIEW_TABLE} set read_at = :read_at
       where identity_id = :identity_id and (id = :id or legacy_id = :id)`,
      params,
      options
    );
    for (const row of viewRows) {
      await notificationArchive.recordRead(
        { scope: 'one', identity_id, id: Number(row.id), read_at: readAt },
        connection
      );
    }
    if (mode === 'shadow' || legacyOutputEnabled()) {
      await this.db.execute(
        `update ${IDENTITY_NOTIFICATIONS_TABLE} set read_at = :read_at
         where identity_id = :identity_id and (
           id = :id
           or id in (
             select legacy_id from ${NOTIFICATION_VIEW_TABLE}
             where identity_id = :identity_id and id = :id and legacy_id is not null
           )
         )`,
        params,
        options
      );
    }
  }

  async markAllNotificationsAsRead(identity_id: string, ctx: RequestContext) {
    ctx.timer?.start(`${this.constructor.name}->markAllNotificationsAsRead`);
    const viewOn = notifyViewMode() !== 'off';
    if (viewOn && !ctx.connection) {
      await this.db.executeNativeQueriesInTransaction((connection) =>
        this.markAllNotificationsAsRead(identity_id, { ...ctx, connection })
      );
      ctx.timer?.stop(`${this.constructor.name}->markAllNotificationsAsRead`);
      return;
    }
    const readAt = Time.currentMillis();
    if (viewOn && ctx.connection) {
      await notificationArchive.recordRead(
        {
          scope: 'all',
          identity_id,
          read_at: readAt,
          source_keys: await this.unreadViewKeys(
            identity_id,
            null,
            ctx.connection
          )
        },
        ctx.connection
      );
    }
    for (const table of this.markReadTables()) {
      await this.db.execute(
        `
        update ${table}
        set read_at = :read_at
        where
          identity_id = :identity_id
          and read_at is null
      `,
        {
          identity_id,
          read_at: readAt
        },
        { wrappedConnection: ctx.connection }
      );
    }
    ctx.timer?.stop(`${this.constructor.name}->markAllNotificationsAsRead`);
  }

  /** Marks the wave's unread notifications read; returns how many changed. */
  async markWaveNotificationsAsRead(
    waveId: string,
    identityId: string,
    ctx: RequestContext
  ): Promise<number> {
    ctx.timer?.start(`${this.constructor.name}->markWaveNotificationsAsRead`);
    const viewOn = notifyViewMode() !== 'off';
    if (viewOn && !ctx.connection) {
      const marked = await this.db.executeNativeQueriesInTransaction(
        (connection) =>
          this.markWaveNotificationsAsRead(waveId, identityId, {
            ...ctx,
            connection
          })
      );
      ctx.timer?.stop(`${this.constructor.name}->markWaveNotificationsAsRead`);
      return marked;
    }
    const readAt = Time.currentMillis();
    if (viewOn && ctx.connection) {
      await notificationArchive.recordRead(
        {
          scope: 'wave',
          identity_id: identityId,
          wave_id: waveId,
          read_at: readAt,
          source_keys: await this.unreadViewKeys(
            identityId,
            waveId,
            ctx.connection
          )
        },
        ctx.connection
      );
    }
    // The first table is the one readers use; its count is the answer.
    const counts: number[] = [];
    for (const table of this.markReadTables()) {
      const result = await this.db.execute(
        `
        update ${table}
        set read_at = :read_at
        where
          wave_id = :wave_id
          and identity_id = :identity_id
          and read_at is null
      `,
        {
          wave_id: waveId,
          identity_id: identityId,
          read_at: readAt
        },
        { wrappedConnection: ctx.connection }
      );
      counts.push(this.db.getAffectedRows(result));
    }
    ctx.timer?.stop(`${this.constructor.name}->markWaveNotificationsAsRead`);
    return counts[0] ?? 0;
  }

  /** The view rows a mark-all (or mark-wave) is about to read, locked. */
  private async unreadViewKeys(
    identityId: string,
    waveId: string | null,
    connection: ConnectionWrapper<any>
  ): Promise<string[]> {
    const rows = await this.db.execute<{ source_key: string }>(
      `select source_key from ${NOTIFICATION_VIEW_TABLE}
       where identity_id = :identityId and read_at is null${
         waveId === null ? '' : ' and wave_id = :waveId'
       }
       order by source_key
       for update`,
      { identityId, waveId },
      { wrappedConnection: connection }
    );
    return rows.map((row) => row.source_key);
  }

  /**
   * Where a mark-read goes, the readers' table first: in `shadow` also the
   * view, so the deriver's rows keep their read state at the switch; in
   * `on` also identity_notifications while it is kept for a rollback.
   */
  private markReadTables(): string[] {
    switch (notifyViewMode()) {
      case 'off':
        return [IDENTITY_NOTIFICATIONS_TABLE];
      case 'shadow':
        return [IDENTITY_NOTIFICATIONS_TABLE, NOTIFICATION_VIEW_TABLE];
      case 'on':
        return legacyOutputEnabled()
          ? [NOTIFICATION_VIEW_TABLE, IDENTITY_NOTIFICATIONS_TABLE]
          : [NOTIFICATION_VIEW_TABLE];
    }
  }

  /**
   * The viewer's groups as one shared table (see viewerGroupsCte), so a
   * notification read inlines them once instead of three times: the
   * notification's own visibility, its wave and the wave's parent. Undefined
   * without groups, or while the compared columns' collation differs.
   */
  private async sharedViewerGroups(
    groupIds: string[]
  ): Promise<ViewerGroupsCte | undefined> {
    if (!groupIds.length) return undefined;
    const supported = await viewerGroupsCteSupported(this.db, [
      notificationsReadTable(),
      WAVES_TABLE,
      legacyGetView(WAVES_TABLE)
    ]);
    return supported
      ? viewerGroupSets.source(this.db, 'ntf_viewer_groups', groupIds)
      : undefined;
  }

  /**
   * The causes a person's notification preferences hide. In `on` mode they
   * apply when the view is read, because the view keeps every derived row
   * (so a rebuild does not depend on today's preferences). Rows in
   * identity_notifications were filtered when they were written.
   */
  private async causesHiddenByPreferences(
    identityId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<IdentityNotificationCause[]> {
    if (notifyViewMode() !== 'on') return [];
    const preferences =
      (await this.profilePreferencesDb.getMany([identityId], connection)).get(
        identityId
      ) ?? DEFAULT_PROFILE_PREFERENCES;
    return Object.values(IdentityNotificationCause).filter(
      (cause) => !isNotificationEnabled(cause, preferences)
    );
  }

  async findNotifications(
    param: {
      identity_id: string;
      id_less_than: number | null;
      limit: number;
      eligible_group_ids: string[];
      cause: string | null;
      cause_exclude: string | null;
      unread_only: boolean;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<IdentityNotificationDeserialized[]> {
    const causes = param.cause?.split(',').map((it) => it.trim());
    const hidden = await this.causesHiddenByPreferences(
      param.identity_id,
      connection
    );
    const requestedExclude =
      param.cause_exclude?.split(',').map((it) => it.trim()) ?? [];
    const causesExclude =
      requestedExclude.length || hidden.length
        ? [...requestedExclude, ...hidden]
        : undefined;
    const groups = await this.sharedViewerGroups(param.eligible_group_ids);
    return this.db
      .execute<IdentityNotificationEntity>(
        `
        ${groups ? `WITH ${groups.cteSql}` : ''}
        SELECT n.* FROM ${notificationsReadTable()} n
        LEFT JOIN ${WAVE_READER_METRICS_TABLE} r
          ON r.wave_id = n.wave_id
          AND r.reader_id = n.identity_id
        LEFT JOIN ${IDENTITY_MUTES_TABLE} m
          ON m.muter_id = n.identity_id
          AND m.muted_identity_id = n.additional_identity_id
        LEFT JOIN ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE} b
          ON b.blocker_profile_id = n.identity_id
          AND b.blocked_profile_id = n.additional_identity_id
        LEFT JOIN ${CONTENT_MODERATION_DROP_STATES_TABLE} d1
          ON d1.drop_id = n.related_drop_id
        LEFT JOIN ${CONTENT_MODERATION_DROP_STATES_TABLE} d2
          ON d2.drop_id = n.related_drop_2_id
        LEFT JOIN ${DROPS_TABLE} rd1
          ON rd1.id = n.related_drop_id
        LEFT JOIN ${DROPS_TABLE} rd2
          ON rd2.id = n.related_drop_2_id
        WHERE n.identity_id = :identity_id ${
          param.id_less_than === null ? `` : `AND n.id < :id_less_than`
        }
        AND (
          n.additional_identity_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM ${IDENTITIES_TABLE} i
            WHERE i.profile_id = n.additional_identity_id
          )
        )
        AND (n.visibility_group_id IS NULL ${
          param.eligible_group_ids.length
            ? ` OR n.visibility_group_id IN (${groups?.setSql ?? ':eligible_group_ids'}) `
            : ``
        })
        AND ${optionalWaveReadAccessSql('n.wave_id', param.eligible_group_ids.length > 0, 'eligible_group_ids', groups?.setSql)}
        ${causes ? ` AND n.cause IN (:causes)` : ``}
        ${causesExclude ? ` AND n.cause NOT IN (:causesExclude)` : ``}
        ${param.unread_only ? ` AND n.read_at IS NULL` : ``}
        AND ${COMPETITION_NOTIFICATION_VISIBILITY_SQL}
        AND ${artistArtworkNotificationVisibleSql('n')}
        AND COALESCE(r.muted, FALSE) = FALSE
        AND (m.id IS NULL OR ${anonymousNotificationActorSql('n')})
        AND (b.id IS NULL OR ${anonymousNotificationActorSql('n')})
        AND (
          d1.status IS NULL
          OR d1.status = '${DropModerationStatus.VISIBLE}'
          OR rd1.author_id = n.identity_id
        )
        AND (
          d2.status IS NULL
          OR d2.status = '${DropModerationStatus.VISIBLE}'
          OR rd2.author_id = n.identity_id
        )
        ORDER BY n.id DESC LIMIT :limit
      `,
        { ...param, causes, causesExclude, ...groups?.params },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((results) =>
        results.map((it) => ({
          ...it,
          additional_data: JSON.parse(it.additional_data),
          related_drop_part_no: numbers.parseIntOrNull(
            it.related_drop_part_no?.toString()
          ),
          related_drop_2_part_no: numbers.parseIntOrNull(
            it.related_drop_2_part_no?.toString()
          ),
          created_at: parseInt(it.created_at.toString()),
          read_at: numbers.parseIntOrNull(it.read_at?.toString()),
          id: parseInt(it.id.toString())
        }))
      );
  }

  async countUnreadNotificationsForIdentity(
    identity_id: string,
    eligibleGroupIds: string[],
    connection?: ConnectionWrapper<any>,
    options?: {
      enabledCauses?: IdentityNotificationCause[];
      excludedCauses?: IdentityNotificationCause[];
      forcePool?: DbPoolName;
    }
  ): Promise<number> {
    const enabledCauses = options?.enabledCauses;
    const hasEnabledCauses =
      enabledCauses !== undefined && enabledCauses.length > 0;
    const causeClause = hasEnabledCauses
      ? ` AND n.cause IN (:enabledCauses)`
      : '';
    const hidden = await this.causesHiddenByPreferences(
      identity_id,
      connection
    );
    const excludedCauses = [...(options?.excludedCauses ?? []), ...hidden];
    const hasExcludedCauses = excludedCauses.length > 0;
    const excludeCauseClause = hasExcludedCauses
      ? ` AND n.cause NOT IN (:excludedCauses)`
      : '';

    const queryParams: {
      identity_id: string;
      eligibleGroupIds: string[];
      enabledCauses?: IdentityNotificationCause[];
      excludedCauses?: IdentityNotificationCause[];
    } = {
      identity_id,
      eligibleGroupIds
    };
    if (hasEnabledCauses) {
      queryParams.enabledCauses = enabledCauses;
    }
    if (hasExcludedCauses) {
      queryParams.excludedCauses = excludedCauses;
    }

    const queryOptions = connection
      ? { wrappedConnection: connection }
      : undefined;
    const groups = await this.sharedViewerGroups(eligibleGroupIds);

    return this.db
      .oneOrNull<{ cnt: number }>(
        `
        ${groups ? `WITH ${groups.cteSql}` : ''}
        SELECT COUNT(*) AS cnt
        FROM ${notificationsReadTable()} n
        LEFT JOIN ${WAVE_READER_METRICS_TABLE} r
          ON r.wave_id = n.wave_id
          AND r.reader_id = n.identity_id
        LEFT JOIN ${IDENTITY_MUTES_TABLE} m
          ON m.muter_id = n.identity_id
          AND m.muted_identity_id = n.additional_identity_id
        LEFT JOIN ${CONTENT_MODERATION_PROFILE_BLOCKS_TABLE} b
          ON b.blocker_profile_id = n.identity_id
          AND b.blocked_profile_id = n.additional_identity_id
        LEFT JOIN ${CONTENT_MODERATION_DROP_STATES_TABLE} d1
          ON d1.drop_id = n.related_drop_id
        LEFT JOIN ${CONTENT_MODERATION_DROP_STATES_TABLE} d2
          ON d2.drop_id = n.related_drop_2_id
        LEFT JOIN ${DROPS_TABLE} rd1
          ON rd1.id = n.related_drop_id
        LEFT JOIN ${DROPS_TABLE} rd2
          ON rd2.id = n.related_drop_2_id
        WHERE (
          (
            n.identity_id = :identity_id
            AND n.read_at IS NULL
            AND (n.visibility_group_id IS NULL ${
              eligibleGroupIds.length
                ? ` OR n.visibility_group_id IN (${groups?.setSql ?? ':eligibleGroupIds'}) `
                : ``
            })
            AND ${optionalWaveReadAccessSql('n.wave_id', eligibleGroupIds.length > 0, 'eligibleGroupIds', groups?.setSql)}
            AND COALESCE(r.muted, FALSE) = FALSE
            AND (m.id IS NULL OR ${anonymousNotificationActorSql('n')})
            AND (b.id IS NULL OR ${anonymousNotificationActorSql('n')})
            AND (
              d1.status IS NULL
              OR d1.status = '${DropModerationStatus.VISIBLE}'
              OR rd1.author_id = n.identity_id
            )
            AND (
              d2.status IS NULL
              OR d2.status = '${DropModerationStatus.VISIBLE}'
              OR rd2.author_id = n.identity_id
            )
          )
        )${causeClause}${excludeCauseClause}
        AND ${COMPETITION_NOTIFICATION_VISIBILITY_SQL}
        AND ${artistArtworkNotificationVisibleSql('n')}
      `,
        { ...queryParams, ...groups?.params },
        options?.forcePool
          ? { ...queryOptions, forcePool: options.forcePool }
          : queryOptions
      )
      .then((it) => it?.cnt ?? 0);
  }

  async updateIdentityIdsInNotifications(
    sourceIdentity: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.updateIdentityIdsInTable(
      IDENTITY_NOTIFICATIONS_TABLE,
      sourceIdentity,
      target,
      connectionHolder
    );
    if (notifyViewMode() !== 'off') {
      await this.moveViewRows(sourceIdentity, target, connectionHolder);
      // A rebuild moves the rows the archive sealed under the source.
      await notificationArchive.recordMerge(sourceIdentity, target, {
        connection: connectionHolder
      });
    }
  }

  /**
   * A merge moves the view's rows to the target re-keyed for their new
   * recipient, as the rules key them, so the next application of a group
   * finds its row (and its read state) and a rebuild writes the same keys
   * and ids. Where the target already has the row, the moved duplicate
   * goes. Copies made at the switch keep their old ids. A duplicate that
   * goes leaves its identity_notifications copy, now under the target, and
   * a later `copy-old-rows` carries it (a `--full` run always does). No
   * cause with a feed today notifies more than one person per event, so
   * none arises yet; such a cause must delete that copy here before it
   * joins.
   */
  async moveViewRows(
    source: string,
    target: string,
    connection: ConnectionWrapper<any>
  ): Promise<void> {
    const options = { wrappedConnection: connection };
    const rows = await this.db.execute<{
      source_key: string;
      source_family: string;
      source_ref: string;
      id: number;
      legacy_id: number | null;
      created_at: number;
    }>(
      `select source_key, source_family, source_ref, id, legacy_id, created_at
       from ${NOTIFICATION_VIEW_TABLE} where identity_id = :source
       order by source_key for update`,
      { source },
      options
    );
    const moves = rows.map((row) => {
      const key = notificationSourceKey(
        row.source_family,
        row.source_ref,
        target
      );
      const keepsOldId =
        row.legacy_id !== null && Number(row.legacy_id) === Number(row.id);
      return {
        from: row.source_key,
        key,
        id: keepsOldId
          ? Number(row.id)
          : notificationViewId(Number(row.created_at), key)
      };
    });
    for (let i = 0; i < moves.length; i += VIEW_MOVE_CHUNK) {
      const chunk = moves.slice(i, i + VIEW_MOVE_CHUNK);
      const taken = new Set(
        (
          await this.db.execute<{ source_key: string }>(
            `select source_key from ${NOTIFICATION_VIEW_TABLE}
             where identity_id = :target and source_key in (:keys)`,
            { target, keys: chunk.map((move) => move.key) },
            options
          )
        ).map((row) => row.source_key)
      );
      const duplicates = chunk.filter((move) => taken.has(move.key));
      if (duplicates.length) {
        await this.db.execute(
          `delete from ${NOTIFICATION_VIEW_TABLE}
           where identity_id = :source and source_key in (:keys)`,
          { source, keys: duplicates.map((move) => move.from) },
          options
        );
      }
      const params: Record<string, string | number> = { source, target };
      const mapped = chunk
        .filter((move) => !taken.has(move.key))
        .map((move, index) => {
          params[`from_${index}`] = move.from;
          params[`key_${index}`] = move.key;
          params[`id_${index}`] = move.id;
          return `select :from_${index} as from_key, :key_${index} as new_key, :id_${index} as new_id`;
        });
      if (mapped.length) {
        await this.db.execute(
          `update ${NOTIFICATION_VIEW_TABLE} v
           join (${mapped.join(' union all ')}) m
             on v.identity_id = :source and v.source_key = m.from_key
           set v.identity_id = :target, v.source_key = m.new_key, v.id = m.new_id`,
          params,
          options
        );
      }
    }
    await this.db.execute(
      `update ${NOTIFICATION_VIEW_TABLE} set additional_identity_id = :target
       where additional_identity_id = :source`,
      { source, target },
      options
    );
  }

  private async updateIdentityIdsInTable(
    table: string,
    sourceIdentity: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${table} set identity_id = :target where identity_id = :sourceIdentity`,
      { sourceIdentity, target },
      { wrappedConnection: connectionHolder }
    );
    await this.db.execute(
      `update ${table} set additional_identity_id = :target where additional_identity_id = :sourceIdentity`,
      { sourceIdentity, target },
      { wrappedConnection: connectionHolder }
    );
  }

  async findIdentitiesNotifiedForDropCreation(
    waveId: string,
    dropId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<string[]> {
    return this.db
      .execute<{
        identity_id: string;
      }>(
        `
          select distinct identity_id
          from ${IDENTITY_NOTIFICATIONS_TABLE}
          where wave_id = :waveId
            and related_drop_id = :dropId
            and cause in (:causes)
        `,
        {
          waveId,
          dropId,
          causes: [
            IdentityNotificationCause.DROP_REPLIED,
            IdentityNotificationCause.DROP_QUOTED,
            IdentityNotificationCause.IDENTITY_MENTIONED,
            IdentityNotificationCause.ALL_DROPS
          ]
        },
        { wrappedConnection: connection }
      )
      .then((it) => it.map((it) => it.identity_id));
  }
}

export type NewIdentityNotification = Omit<
  IdentityNotificationDeserialized,
  'id' | 'created_at' | 'read_at'
>;

export interface IdentityNotificationDeserialized extends Omit<
  IdentityNotificationEntity,
  'additional_data'
> {
  readonly additional_data: any;
}

export const identityNotificationsDb = new IdentityNotificationsDb(dbSupplier);
