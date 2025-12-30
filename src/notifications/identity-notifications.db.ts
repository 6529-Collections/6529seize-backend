import { sendIdentityPushNotification } from '../api-serverless/src/push-notifications/push-notifications.service';
import {
  IDENTITIES_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  WAVE_READER_METRICS_TABLE
} from '../constants';
import { IdentityNotificationEntity } from '../entities/IIdentityNotification';
import { Logger } from '../logging';
import { numbers } from '../numbers';
import { RequestContext } from '../request.context';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { Time } from '../time';

export class IdentityNotificationsDb extends LazyDbAccessCompatibleService {
  private readonly logger = Logger.get(IdentityNotificationsDb.name);

  private isNotifierActivated() {
    return process.env.USER_NOTIFIER_ACTIVATED === 'true';
  }

  async insertNotification(
    notification: NewIdentityNotification,
    connection?: ConnectionWrapper<any>
  ) {
    if (this.isNotifierActivated()) {
      const result = await this.db.execute(
        `
        insert into ${IDENTITY_NOTIFICATIONS_TABLE} (
          identity_id, 
          additional_identity_id,
          related_drop_id,
          related_drop_part_no,
          related_drop_2_id,
          related_drop_2_part_no,
          cause,
          additional_data, 
          created_at,
          visibility_group_id,
          wave_id
        ) values (
          :identity_id,
          :additional_identity_id,
          :related_drop_id,
          :related_drop_part_no,
          :related_drop_2_id,
          :related_drop_2_part_no,
          :cause,
          :additional_data,
          :created_at,
          :visibility_group_id,
          :wave_id
        )
      `,
        {
          ...notification,
          created_at: Time.currentMillis(),
          additional_data: JSON.stringify(notification.additional_data)
        },
        connection ? { wrappedConnection: connection } : undefined
      );

      const notificationId: number = result?.[2] ?? null;

      if (notificationId) {
        await sendIdentityPushNotification(notificationId);
      } else {
        this.logger.error('No notification id returned from insert');
      }
    }
  }

  async updateNotificationReadAt(
    {
      id,
      identity_id,
      readAt
    }: { id: number; identity_id: string; readAt: number | null },
    connection?: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
        update ${IDENTITY_NOTIFICATIONS_TABLE}
        set read_at = :read_at
        where 
          id = :id 
          and identity_id = :identity_id
      `,
      {
        id,
        identity_id,
        read_at: readAt
      },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async markAllNotificationsAsRead(identity_id: string, ctx: RequestContext) {
    ctx.timer?.start(`${this.constructor.name}->markAllNotificationsAsRead`);
    await this.db.execute(
      `
        update ${IDENTITY_NOTIFICATIONS_TABLE}
        set read_at = :read_at
        where 
          identity_id = :identity_id
          and read_at is null
      `,
      {
        identity_id,
        read_at: Time.currentMillis()
      },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->markAllNotificationsAsRead`);
  }

  async markWaveNotificationsAsRead(
    waveId: string,
    identityId: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->markWaveNotificationsAsRead`);
    await this.db.execute(
      `
        update ${IDENTITY_NOTIFICATIONS_TABLE}
        set read_at = :read_at
        where 
          wave_id = :wave_id 
          and identity_id = :identity_id 
          and read_at is null
      `,
      {
        wave_id: waveId,
        identity_id: identityId,
        read_at: Time.currentMillis()
      },
      { wrappedConnection: ctx.connection }
    );
    ctx.timer?.stop(`${this.constructor.name}->markWaveNotificationsAsRead`);
  }

  async findNotifications(
    param: {
      identity_id: string;
      id_less_than: number | null;
      limit: number;
      eligible_group_ids: string[];
      cause: string | null;
      unread_only: boolean;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<IdentityNotificationDeserialized[]> {
    const causes = param.cause?.split(',').map((it) => it.trim());
    return this.db
      .execute<IdentityNotificationEntity>(
        `
        SELECT n.* FROM ${IDENTITY_NOTIFICATIONS_TABLE} n
        JOIN ${IDENTITIES_TABLE} i ON n.additional_identity_id = i.profile_id
        LEFT JOIN ${WAVE_READER_METRICS_TABLE} r
          ON r.wave_id = n.wave_id
          AND r.reader_id = n.identity_id
        WHERE n.identity_id = :identity_id ${
          param.id_less_than === null ? `` : `AND n.id < :id_less_than`
        }
        AND (n.visibility_group_id IS NULL ${
          param.eligible_group_ids.length
            ? ` OR n.visibility_group_id IN (:eligible_group_ids) `
            : ``
        })
        ${causes ? ` AND n.cause IN (:causes)` : ``}
        ${param.unread_only ? ` AND n.read_at IS NULL` : ``}
        AND COALESCE(r.muted, FALSE) = FALSE
        ORDER BY n.id DESC LIMIT :limit
      `,
        { ...param, causes },
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
    connection?: ConnectionWrapper<any>
  ): Promise<number> {
    return this.db
      .oneOrNull<{ cnt: number }>(
        `
        SELECT COUNT(*) AS cnt
        FROM ${IDENTITY_NOTIFICATIONS_TABLE} n
        LEFT JOIN ${WAVE_READER_METRICS_TABLE} r
          ON r.wave_id = n.wave_id
          AND r.reader_id = n.identity_id
        WHERE n.identity_id = :identity_id
          AND n.read_at IS NULL
          AND (n.visibility_group_id IS NULL ${
            eligibleGroupIds.length
              ? ` OR n.visibility_group_id IN (:eligibleGroupIds) `
              : ``
          })
          AND COALESCE(r.muted, FALSE) = FALSE
      `,
        {
          identity_id,
          eligibleGroupIds
        },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it) => it?.cnt ?? 0);
  }

  async updateIdentityIdsInNotifications(
    sourceIdentity: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `update ${IDENTITY_NOTIFICATIONS_TABLE} set identity_id = :target where identity_id = :sourceIdentity`,
      { sourceIdentity, target },
      { wrappedConnection: connectionHolder }
    );
    await this.db.execute(
      `update ${IDENTITY_NOTIFICATIONS_TABLE} set additional_identity_id = :target where additional_identity_id = :sourceIdentity`,
      { sourceIdentity, target },
      { wrappedConnection: connectionHolder }
    );
  }

  async findIdentitiesNotification(
    waveId: string,
    dropId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<string[]> {
    return this.db
      .execute<{
        identity_id: string;
      }>(
        `select identity_id from ${IDENTITY_NOTIFICATIONS_TABLE} where wave_id = :waveId and (related_drop_id = :dropId or related_drop_2_id = :dropId)`,
        { waveId, dropId },
        { wrappedConnection: connection }
      )
      .then((it) => it.map((it) => it.identity_id));
  }
}

export type NewIdentityNotification = Omit<
  IdentityNotificationDeserialized,
  'id' | 'created_at' | 'read_at'
>;

export interface IdentityNotificationDeserialized
  extends Omit<IdentityNotificationEntity, 'additional_data'> {
  readonly additional_data: any;
}

export const identityNotificationsDb = new IdentityNotificationsDb(dbSupplier);
