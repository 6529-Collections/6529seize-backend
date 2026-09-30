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
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';

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
      include_competitions?: boolean;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<UserNotificationsResponse> {
    const excludedCauses =
      param.include_competitions === true
        ? []
        : [IdentityNotificationCause.COMPETITION_LIFECYCLE];
    const causeExclude = [
      ...(param.cause_exclude?.split(',').map((cause) => cause.trim()) ?? []),
      ...excludedCauses
    ];
    const notificationsRaw =
      await this.identityNotificationsDb.findNotifications(
        {
          ...param,
          cause_exclude: causeExclude.length
            ? Array.from(new Set(causeExclude)).join(',')
            : null
        },
        connection
      );
    const notifications =
      this.userNotificationsMapper.mapNotifications(notificationsRaw);
    // Existing cause filters narrow the page only. Capability filtering also
    // narrows the unread total so older clients never count unsupported rows.
    const totalUnread =
      await this.identityNotificationsDb.countUnreadNotificationsForIdentity(
        param.identity_id,
        param.eligible_group_ids,
        connection,
        { excludedCauses }
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
