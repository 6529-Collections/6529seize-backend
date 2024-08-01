import {
  userNotificationReader,
  UserNotificationsReader
} from '../../../notifications/user-notifications.reader';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { UserNotification } from '../../../notifications/user-notification.types';
import {
  assertUnreachable,
  distinct,
  resolveEnumOrThrow
} from '../../../helpers';
import { IdentityNotificationCause } from '../../../entities/IIdentityNotification';
import {
  profilesApiService,
  ProfilesApiService
} from '../profiles/profiles.api.service';
import { DropsApiService, dropsService } from '../drops/drops.api.service';
import { AuthenticationContext } from '../../../auth-context';
import { Drop } from '../generated/models/Drop';
import { ProfileMin } from '../generated/models/ProfileMin';
import { NotificationsResponse } from '../generated/models/NotificationsResponse';
import { Notification } from '../generated/models/Notification';
import { NotificationCause } from '../generated/models/NotificationCause';
import {
  identityNotificationsDb,
  IdentityNotificationsDb
} from '../../../notifications/identity-notifications.db';

export class NotificationsApiService {
  constructor(
    private readonly notificationsReader: UserNotificationsReader,
    private readonly userGroupsService: UserGroupsService,
    private readonly profilesApiService: ProfilesApiService,
    private readonly dropsService: DropsApiService,
    private readonly identityNotificationsDb: IdentityNotificationsDb
  ) {}

  public async markNotificationAsRead(param: {
    id: number;
    identity_id: string;
  }) {
    await this.identityNotificationsDb.markNotificationAsRead(param);
  }

  public async markAllNotificationsAsRead(identityId: string) {
    await this.identityNotificationsDb.markAllNotificationsAsRead(identityId);
  }

  public async getNotifications(
    param: {
      id_less_than: number | null;
      limit: number;
    },
    authenticationContext: AuthenticationContext
  ): Promise<NotificationsResponse> {
    const eligible_group_ids =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        authenticationContext.getActingAsId()
      );
    const notifications =
      await this.notificationsReader.getNotificationsForIdentity({
        ...param,
        identity_id: authenticationContext.getActingAsId()!,
        eligible_group_ids
      });
    const apiNotifications = await this.mapToApiNotifications(
      notifications.notifications,
      authenticationContext
    );
    return {
      notifications: apiNotifications,
      unread_count: notifications.total_unread
    };
  }

  private async mapToApiNotifications(
    notifications: UserNotification[],
    authenticationContext: AuthenticationContext
  ): Promise<Notification[]> {
    const { profileIds, dropIds } = this.getAllRelatedIds(notifications);
    const [drops, profiles] = await Promise.all([
      this.dropsService.findDropsByIdsOrThrow(dropIds, authenticationContext),
      this.profilesApiService.getProfileMinsByIds({
        ids: profileIds,
        authenticatedProfileId: authenticationContext.getActingAsId()
      })
    ]);
    return notifications.map((notification) =>
      this.mapToApiNotification({ notification, drops, profiles })
    );
  }

  private getAllRelatedIds(notifications: UserNotification[]): {
    profileIds: string[];
    dropIds: string[];
  } {
    const profileIds: string[] = [];
    const dropIds: string[] = [];
    for (const notification of notifications) {
      const notificationCause = notification.cause;
      switch (notificationCause) {
        case IdentityNotificationCause.IDENTITY_SUBSCRIBED: {
          const data = notification.data;
          profileIds.push(data.subscriber_id);
          break;
        }
        case IdentityNotificationCause.IDENTITY_MENTIONED: {
          const data = notification.data;
          profileIds.push(data.mentioner_identity_id);
          dropIds.push(data.drop_id);
          break;
        }
        case IdentityNotificationCause.DROP_VOTED: {
          const data = notification.data;
          profileIds.push(data.voter_id);
          dropIds.push(data.drop_id);
          break;
        }
        case IdentityNotificationCause.DROP_QUOTED: {
          const data = notification.data;
          profileIds.push(data.quote_drop_author_id);
          dropIds.push(data.quoted_drop_id);
          dropIds.push(data.quote_drop_id);
          break;
        }
        case IdentityNotificationCause.DROP_REPLIED: {
          const data = notification.data;
          profileIds.push(data.reply_drop_author_id);
          dropIds.push(data.replied_drop_id);
          dropIds.push(data.reply_drop_id);
          break;
        }
        default: {
          assertUnreachable(notificationCause);
        }
      }
    }
    return { profileIds: distinct(profileIds), dropIds: distinct(dropIds) };
  }

  private mapToApiNotification({
    notification,
    drops,
    profiles
  }: {
    notification: UserNotification;
    drops: Record<string, Drop>;
    profiles: Record<string, ProfileMin>;
  }): Notification {
    const notificationCause = notification.cause;
    switch (notificationCause) {
      case IdentityNotificationCause.IDENTITY_SUBSCRIBED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: resolveEnumOrThrow(NotificationCause, notificationCause),
          related_identity: profiles[data.subscriber_id],
          related_drops: [],
          additional_context: {}
        };
      }
      case IdentityNotificationCause.IDENTITY_MENTIONED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: resolveEnumOrThrow(NotificationCause, notificationCause),
          related_identity: profiles[data.mentioner_identity_id],
          related_drops: [drops[data.drop_id]],
          additional_context: {}
        };
      }
      case IdentityNotificationCause.DROP_VOTED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: resolveEnumOrThrow(NotificationCause, notificationCause),
          related_identity: profiles[data.voter_id],
          related_drops: [drops[data.drop_id]],
          additional_context: {
            vote: data.vote
          }
        };
      }
      case IdentityNotificationCause.DROP_QUOTED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: resolveEnumOrThrow(NotificationCause, notificationCause),
          related_identity: profiles[data.quote_drop_author_id],
          related_drops: [
            drops[data.quote_drop_id],
            drops[data.quoted_drop_id]
          ],
          additional_context: {
            quote_drop_id: data.quote_drop_id,
            quote_drop_part: data.quote_drop_part,
            quoted_drop_id: data.quoted_drop_id,
            quoted_drop_part: data.quoted_drop_part
          }
        };
      }
      case IdentityNotificationCause.DROP_REPLIED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: resolveEnumOrThrow(NotificationCause, notificationCause),
          related_identity: profiles[data.reply_drop_author_id],
          related_drops: [
            drops[data.replied_drop_id],
            drops[data.reply_drop_id]
          ],
          additional_context: {
            reply_drop_id: data.reply_drop_id,
            replied_drop_id: data.replied_drop_id,
            replied_drop_part: data.replied_drop_part
          }
        };
      }
      default: {
        return assertUnreachable(notificationCause);
      }
    }
  }
}

export const notificationsApiService = new NotificationsApiService(
  userNotificationReader,
  userGroupsService,
  profilesApiService,
  dropsService,
  identityNotificationsDb
);
