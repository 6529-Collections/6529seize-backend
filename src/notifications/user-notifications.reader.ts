import { ConnectionWrapper } from '../sql-executor';
import {
  identityNotificationsDb,
  IdentityNotificationsDb
} from './identity-notifications.db';
import {
  UserNotificationMapper,
  userNotificationsMapper
} from './user-notification.mapper';
import { UserNotificationsResponse } from './user-notification.types';

export class UserNotificationsReader {
  constructor(
    private readonly identityNotificationsDb: IdentityNotificationsDb,
    private readonly userNotificationsMapper: UserNotificationMapper
  ) {}

  public async getNotificationsForIdentity(
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
  ): Promise<UserNotificationsResponse> {
    const notificationsRaw =
      await this.identityNotificationsDb.findNotifications(param, connection);
    const notifications =
      this.userNotificationsMapper.mapNotifications(notificationsRaw);
    const totalUnread =
      await this.identityNotificationsDb.countUnreadNotificationsForIdentity(
        param.identity_id,
        param.eligible_group_ids,
        connection
      );
    return {
      notifications,
      total_unread: totalUnread
    };
  }
}

export const userNotificationReader = new UserNotificationsReader(
  identityNotificationsDb,
  userNotificationsMapper
);
