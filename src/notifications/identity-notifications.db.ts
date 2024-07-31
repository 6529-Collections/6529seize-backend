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
  async insertNotification(
    notification: NewIdentityNotification,
    connection?: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
        insert into ${IDENTITY_NOTIFICATIONS_TABLE} (
          identity_id, 
          target_id, 
          target_type, 
          target_action, 
          additional_data, 
          created_at
        ) values (
          :identity_id, 
          :target_id, 
          :target_type, 
          :target_action, 
          :additional_data, 
          :created_at
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

  async markAllIdentityNotificationsAsRead(
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
    param: { identity_id: string; id_less_than: number | null; limit: number },
    connection?: ConnectionWrapper<any>
  ): Promise<IdentityNotificationDeserialized[]> {
    return this.db
      .execute<IdentityNotificationEntity>(
        `
        select * from ${IDENTITY_NOTIFICATIONS_TABLE}
        where identity_id = :identity_id ${
          param.id_less_than !== null ? `and id < :id_less_than` : ``
        } 
        order by id desc limit :limit
      `,
        param,
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((results) =>
        results.map((it) => ({
          ...it,
          additional_data: JSON.parse(it.additional_data),
          created_at: parseInt(it.created_at.toString()),
          read_at: parseIntOrNull(it.read_at?.toString()),
          id: parseInt(it.id.toString())
        }))
      );
  }

  async countUnreadNotificationsForIdentity(
    identity_id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<number> {
    return this.db
      .oneOrNull<{ cnt: number }>(
        `
        select count(*) as cnt from ${IDENTITY_NOTIFICATIONS_TABLE} where identity_id = :identity_id and read_at is null
      `,
        {
          identity_id
        },
        connection ? { wrappedConnection: connection } : undefined
      )
      .then((it) => it?.cnt ?? 0);
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
