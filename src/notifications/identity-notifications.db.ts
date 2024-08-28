import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { IdentityNotificationEntity } from '../entities/IIdentityNotification';
import { IDENTITY_NOTIFICATIONS_TABLE } from '../constants';
import { Time } from '../time';
import { parseIntOrNull } from '../helpers';

export class IdentityNotificationsDb extends LazyDbAccessCompatibleService {
  private isNotifierActivated() {
    return process.env.USER_NOTIFIER_ACTIVATED === 'true';
  }

  async insertNotification(
    notification: NewIdentityNotification,
    connection?: ConnectionWrapper<any>
  ) {
    if (this.isNotifierActivated()) {
      await this.db.execute(
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
    }
  }

  async markNotificationAsRead(
    { id, identity_id }: { id: number; identity_id: string },
    connection?: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
        update ${IDENTITY_NOTIFICATIONS_TABLE}
        set read_at = :read_at
        where id = :id and identity_id = :identity_id
      `,
      {
        id,
        identity_id,
        read_at: Time.currentMillis()
      },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async markAllNotificationsAsRead(
    identity_id: string,
    connection?: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
        update ${IDENTITY_NOTIFICATIONS_TABLE}
        set read_at = :read_at
        where identity_id = :identity_id
      `,
      {
        identity_id,
        read_at: Time.currentMillis()
      },
      connection ? { wrappedConnection: connection } : undefined
    );
  }

  async findNotifications(
    param: {
      identity_id: string;
      id_less_than: number | null;
      limit: number;
      eligible_group_ids: string[];
    },
    connection?: ConnectionWrapper<any>
  ): Promise<IdentityNotificationDeserialized[]> {
    return this.db
      .execute<IdentityNotificationEntity>(
        `
        select * from ${IDENTITY_NOTIFICATIONS_TABLE}
        where identity_id = :identity_id ${
          param.id_less_than !== null ? `and id < :id_less_than` : ``
        }
        and (visibility_group_id is null ${
          param.eligible_group_ids.length
            ? ` or visibility_group_id in (:eligible_group_ids) `
            : ``
        })
        order by id desc limit :limit
      `,
        param,
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((results) =>
        results.map((it) => ({
          ...it,
          additional_data: JSON.parse(it.additional_data),
          related_drop_part_no: parseIntOrNull(
            it.related_drop_part_no?.toString()
          ),
          related_drop_2_part_no: parseIntOrNull(
            it.related_drop_2_part_no?.toString()
          ),
          created_at: parseInt(it.created_at.toString()),
          read_at: parseIntOrNull(it.read_at?.toString()),
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
        select count(*) as cnt from ${IDENTITY_NOTIFICATIONS_TABLE} where identity_id = :identity_id and read_at is null and (visibility_group_id is null ${
          eligibleGroupIds.length
            ? ` or visibility_group_id in (:eligibleGroupIds) `
            : ``
        })
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
