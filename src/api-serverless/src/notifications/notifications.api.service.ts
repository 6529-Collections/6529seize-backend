import { assertUnreachable } from '../../../assertions';
import { AuthenticationContext } from '../../../auth-context';
import { collections } from '../../../collections';
import { IdentityNotificationCause } from '../../../entities/IIdentityNotification';
import { enums } from '../../../enums';
import { BadRequestException } from '../../../exceptions';
import {
  identityNotificationsDb,
  IdentityNotificationsDb
} from '../../../notifications/identity-notifications.db';
import { UserNotification } from '../../../notifications/user-notification.types';
import {
  userNotificationReader,
  UserNotificationsReader
} from '../../../notifications/user-notifications.reader';
import { RequestContext } from '../../../request.context';
import { Time } from '../../../time';
import { seizeSettings } from '@/api/seize-settings';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { DropsApiService, dropsService } from '../drops/drops.api.service';
import { ApiDrop } from '../generated/models/ApiDrop';
import { ApiNotification } from '../generated/models/ApiNotification';
import { ApiNotificationCause } from '../generated/models/ApiNotificationCause';
import { ApiNotificationsResponse } from '../generated/models/ApiNotificationsResponse';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import {
  identityFetcher,
  IdentityFetcher
} from '../identities/identity.fetcher';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import { wavesApiDb, WavesApiDb } from '../waves/waves.api.db';

export class NotificationsApiService {
  constructor(
    private readonly notificationsReader: UserNotificationsReader,
    private readonly userGroupsService: UserGroupsService,
    private readonly identityFetcher: IdentityFetcher,
    private readonly dropsService: DropsApiService,
    private readonly identityNotificationsDb: IdentityNotificationsDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly wavesApiDb: WavesApiDb
  ) {}

  public async markNotificationAsRead(param: {
    id: number;
    identity_id: string;
  }) {
    await this.identityNotificationsDb.updateNotificationReadAt({
      ...param,
      readAt: Time.currentMillis()
    });
  }

  public async markNotificationAsUnread(param: {
    id: number;
    identity_id: string;
  }) {
    await this.identityNotificationsDb.updateNotificationReadAt({
      ...param,
      readAt: null
    });
  }

  public async markAllNotificationsAsRead(
    identityId: string,
    ctx: RequestContext
  ): Promise<void> {
    ctx.timer?.start(`${this.constructor.name}->markAllNotificationsAsRead`);
    await this.identityNotificationsDb.markAllNotificationsAsRead(
      identityId,
      ctx
    );
    ctx.timer?.stop(`${this.constructor.name}->markAllNotificationsAsRead`);
  }

  public async markWaveNotificationsAsRead(
    waveId: string,
    identityId: string,
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->markWaveNotificationsAsRead`);
    await this.identityNotificationsDb.markWaveNotificationsAsRead(
      waveId,
      identityId,
      ctx
    );
    await this.wavesApiDb.updateWaveReaderMetricLatestReadTimestamp(
      waveId,
      identityId,
      ctx
    );
    ctx.timer?.stop(`${this.constructor.name}->markWaveNotificationsAsRead`);
  }

  public async getNotifications(
    param: {
      id_less_than: number | null;
      limit: number;
      cause: string | null;
      cause_exclude: string | null;
      unread_only: boolean;
    },
    authenticationContext: AuthenticationContext
  ): Promise<ApiNotificationsResponse> {
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
  ): Promise<ApiNotification[]> {
    const { profileIds, dropIds } = this.getAllRelatedIds(notifications);
    const [drops, profiles] = await Promise.all([
      this.dropsService.findDropsByIdsOrThrow(dropIds, authenticationContext),
      this.identityFetcher.getOverviewsByIds(profileIds, {
        authenticationContext
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
        case IdentityNotificationCause.IDENTITY_REP:
        case IdentityNotificationCause.IDENTITY_NIC: {
          const data = notification.data;
          profileIds.push(data.rater_id);
          break;
        }
        case IdentityNotificationCause.DROP_VOTED: {
          const data = notification.data;
          profileIds.push(data.voter_id);
          dropIds.push(data.drop_id);
          break;
        }
        case IdentityNotificationCause.DROP_REACTED: {
          const data = notification.data;
          profileIds.push(data.profile_id);
          dropIds.push(data.drop_id);
          break;
        }
        case IdentityNotificationCause.DROP_BOOSTED: {
          const data = notification.data;
          profileIds.push(data.booster_id);
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
        case IdentityNotificationCause.WAVE_CREATED: {
          const data = notification.data;
          profileIds.push(data.created_by);
          break;
        }
        case IdentityNotificationCause.ALL_DROPS:
        case IdentityNotificationCause.PRIORITY_ALERT: {
          const data = notification.data;
          profileIds.push(data.additional_identity_id);
          dropIds.push(data.drop_id);
          break;
        }
        default: {
          assertUnreachable(notificationCause);
        }
      }
    }
    return {
      profileIds: collections.distinct(profileIds),
      dropIds: collections.distinct(dropIds)
    };
  }

  private mapToApiNotification({
    notification,
    drops,
    profiles
  }: {
    notification: UserNotification;
    drops: Record<string, ApiDrop>;
    profiles: Record<string, ApiProfileMin>;
  }): ApiNotification {
    const notificationCause = notification.cause;
    switch (notificationCause) {
      case IdentityNotificationCause.IDENTITY_SUBSCRIBED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
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
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
          related_identity: profiles[data.mentioner_identity_id],
          related_drops: [drops[data.drop_id]],
          additional_context: {}
        };
      }
      case IdentityNotificationCause.IDENTITY_REP: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
          related_identity: profiles[data.rater_id],
          related_drops: [],
          additional_context: {
            amount: data.amount,
            total: data.total,
            category: data.category
          }
        };
      }
      case IdentityNotificationCause.IDENTITY_NIC: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
          related_identity: profiles[data.rater_id],
          related_drops: [],
          additional_context: {
            amount: data.amount,
            total: data.total
          }
        };
      }
      case IdentityNotificationCause.DROP_VOTED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
          related_identity: profiles[data.voter_id],
          related_drops: [drops[data.drop_id]],
          additional_context: {
            vote: data.vote
          }
        };
      }
      case IdentityNotificationCause.DROP_REACTED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
          related_identity: profiles[data.profile_id],
          related_drops: [drops[data.drop_id]],
          additional_context: {
            reaction: data.reaction
          }
        };
      }
      case IdentityNotificationCause.DROP_BOOSTED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
          related_identity: profiles[data.booster_id],
          related_drops: [drops[data.drop_id]],
          additional_context: {}
        };
      }
      case IdentityNotificationCause.DROP_QUOTED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
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
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
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
      case IdentityNotificationCause.WAVE_CREATED: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
          related_identity: profiles[data.created_by],
          related_drops: [],
          additional_context: {
            wave_id: data.wave_id
          }
        };
      }
      case IdentityNotificationCause.ALL_DROPS: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
          related_identity: profiles[data.additional_identity_id],
          related_drops: [drops[data.drop_id]],
          additional_context: {
            vote: data.vote
          }
        };
      }
      case IdentityNotificationCause.PRIORITY_ALERT: {
        const data = notification.data;
        return {
          id: notification.id,
          created_at: notification.created_at,
          read_at: notification.read_at,
          cause: enums.resolveOrThrow(ApiNotificationCause, notificationCause),
          related_identity: profiles[data.additional_identity_id],
          related_drops: [drops[data.drop_id]],
          additional_context: {}
        };
      }
      default: {
        return assertUnreachable(notificationCause);
      }
    }
  }

  public async countWaveSubscribers(waveId: string) {
    return this.identitySubscriptionsDb.countWaveSubscribers(waveId);
  }

  public async getWaveSubscription(identityId: string, waveId: string) {
    return this.identitySubscriptionsDb.getWaveSubscription(identityId, waveId);
  }

  public async subscribeToAllWaveDrops(identityId: string, waveId: string) {
    const waveMembersCount =
      await notificationsApiService.countWaveSubscribers(waveId);

    const subscribersLimit =
      seizeSettings().all_drops_notifications_subscribers_limit;
    if (waveMembersCount >= subscribersLimit) {
      throw new BadRequestException(
        `Wave has too many subscribers (${waveMembersCount}). Max is ${subscribersLimit}.`
      );
    }
    await this.identitySubscriptionsDb.subscribeToAllDrops(identityId, waveId);
  }

  public async unsubscribeFromAllWaveDrops(identityId: string, waveId: string) {
    await this.identitySubscriptionsDb.unsubscribeFromAllDrops(
      identityId,
      waveId
    );
  }
}

export const notificationsApiService = new NotificationsApiService(
  userNotificationReader,
  userGroupsService,
  identityFetcher,
  dropsService,
  identityNotificationsDb,
  identitySubscriptionsDb,
  wavesApiDb
);
