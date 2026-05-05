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
import { ApiDropV2 } from '@/api/generated/models/ApiDropV2';
import { ApiIdentityOverview } from '@/api/generated/models/ApiIdentityOverview';
import { ApiNotificationV2 } from '@/api/generated/models/ApiNotificationV2';
import { ApiNotificationsResponseV2 } from '@/api/generated/models/ApiNotificationsResponseV2';
import { ApiWaveOverview } from '@/api/generated/models/ApiWaveOverview';
import {
  DropReactionProfileRow,
  reactionsDb as defaultReactionsDb,
  ReactionsDb
} from '@/api/drops/reactions.db';
import { seizeSettings } from '@/api/seize-settings';
import {
  apiWaveOverviewMapper as defaultApiWaveOverviewMapper,
  ApiWaveOverviewMapper
} from '@/api/waves/api-wave-overview.mapper';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { DropsApiService, dropsService } from '../drops/drops.api.service';
import { ApiDrop } from '../generated/models/ApiDrop';
import { ApiDropGroupMention } from '../generated/models/ApiDropGroupMention';
import { ApiNotification } from '../generated/models/ApiNotification';
import { ApiNotificationCause } from '../generated/models/ApiNotificationCause';
import { ApiNotificationsResponse } from '../generated/models/ApiNotificationsResponse';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { ApiUpdateWaveNotificationPreferencesRequest } from '../generated/models/ApiUpdateWaveNotificationPreferencesRequest';
import { ApiWaveNotificationPreferences } from '../generated/models/ApiWaveNotificationPreferences';
import {
  identityFetcher,
  IdentityFetcher
} from '../identities/identity.fetcher';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import { wavesApiDb, WavesApiDb } from '../waves/waves.api.db';
import { DropGroupMention } from '@/entities/IWaveGroupNotificationSubscription';
import {
  waveGroupNotificationSubscriptionsDb,
  WaveGroupNotificationSubscriptionsDb
} from '@/notifications/wave-group-notification-subscriptions.db';

interface DropReactedNotificationAdditionalContextV2 {
  reaction: string;
  reactors: Array<{
    handle?: string;
    pfp?: string;
  }>;
}

export class NotificationsApiService {
  constructor(
    private readonly notificationsReader: UserNotificationsReader,
    private readonly userGroupsService: UserGroupsService,
    private readonly identityFetcher: IdentityFetcher,
    private readonly dropsService: DropsApiService,
    private readonly identityNotificationsDb: IdentityNotificationsDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly wavesApiDb: WavesApiDb,
    private readonly waveGroupNotificationSubscriptionsDb: WaveGroupNotificationSubscriptionsDb,
    private readonly reactionsDb: ReactionsDb = defaultReactionsDb,
    private readonly apiWaveOverviewMapper: ApiWaveOverviewMapper = defaultApiWaveOverviewMapper
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

  public async getNotificationsV2(
    param: {
      id_less_than: number | null;
      limit: number;
      cause: string | null;
      cause_exclude: string | null;
      unread_only: boolean;
    },
    authenticationContext: AuthenticationContext,
    ctx: RequestContext
  ): Promise<ApiNotificationsResponseV2> {
    const requestContext = { ...ctx, authenticationContext };
    const eligible_group_ids =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        authenticationContext.getActingAsId(),
        requestContext.timer
      );
    const notifications =
      await this.notificationsReader.getNotificationsForIdentity({
        ...param,
        identity_id: authenticationContext.getActingAsId()!,
        eligible_group_ids
      });
    const apiNotifications = await this.mapToApiNotificationsV2(
      notifications.notifications,
      eligible_group_ids,
      requestContext
    );
    return {
      notifications: apiNotifications,
      unread_count: notifications.total_unread
    };
  }

  private async mapToApiNotificationsV2(
    notifications: UserNotification[],
    eligibleGroupIds: string[],
    ctx: RequestContext
  ): Promise<ApiNotificationV2[]> {
    const { profileIds, dropIds } = this.getAllRelatedIds(notifications);
    const waveIds = this.getAllRelatedWaveIds(notifications);
    const reactionRowsByDropId = await this.getReactionRowsByDropId(
      notifications,
      ctx
    );
    const reactorProfileIds =
      this.getAllReactorProfileIds(reactionRowsByDropId);
    const [drops, profiles, waves] = await Promise.all([
      this.dropsService.findDropsV2ByIds(dropIds, ctx),
      this.identityFetcher.getApiIdentityOverviewsByIds(
        collections.distinct([...profileIds, ...reactorProfileIds]),
        ctx
      ),
      this.findRelatedWaveOverviews(waveIds, eligibleGroupIds, ctx)
    ]);
    return notifications
      .filter((notification) => this.hasAllRelatedDropsV2(notification, drops))
      .map((notification) =>
        this.mapToApiNotificationV2({
          notification,
          drops,
          profiles,
          waves,
          reactionRowsByDropId
        })
      );
  }

  private async findRelatedWaveOverviews(
    waveIds: string[],
    eligibleGroupIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, ApiWaveOverview>> {
    if (!waveIds.length) {
      return {};
    }
    const waveEntities = await this.wavesApiDb.findWavesByIds(
      waveIds,
      eligibleGroupIds,
      ctx.connection
    );
    return this.apiWaveOverviewMapper.mapWaves(waveEntities, ctx);
  }

  private async getReactionRowsByDropId(
    notifications: UserNotification[],
    ctx: RequestContext
  ): Promise<Map<string, DropReactionProfileRow[]>> {
    const dropIds = collections.distinct(
      notifications.flatMap((notification) =>
        notification.cause === IdentityNotificationCause.DROP_REACTED
          ? [notification.data.drop_id]
          : []
      )
    );
    if (!dropIds.length) {
      return new Map();
    }
    const entries = await Promise.all(
      dropIds.map(async (dropId) => {
        const rows = await this.reactionsDb.getReactionProfilesByDropId(
          dropId,
          ctx
        );
        return [dropId, rows] as const;
      })
    );
    return new Map(entries);
  }

  private getAllReactorProfileIds(
    reactionRowsByDropId: Map<string, DropReactionProfileRow[]>
  ): string[] {
    return collections.distinct(
      Array.from(reactionRowsByDropId.values()).flatMap((rows) =>
        rows.map((row) => row.profile_id)
      )
    );
  }

  private async mapToApiNotifications(
    notifications: UserNotification[],
    authenticationContext: AuthenticationContext
  ): Promise<ApiNotification[]> {
    const { profileIds, dropIds } = this.getAllRelatedIds(notifications);
    const [drops, profiles] = await Promise.all([
      this.dropsService.findDropsByIds(dropIds, authenticationContext),
      this.identityFetcher.getOverviewsByIds(profileIds, {
        authenticationContext
      })
    ]);
    return notifications
      .filter((notification) =>
        this.hasAllRelatedDropsV1({ notification, drops })
      )
      .map((notification) =>
        this.mapToApiNotification({ notification, drops, profiles })
      );
  }

  private hasAllRelatedDropsV1({
    notification,
    drops
  }: {
    notification: UserNotification;
    drops: Record<string, ApiDrop>;
  }): boolean {
    return this.getAllRelatedIds([notification]).dropIds.every(
      (dropId) => !!drops[dropId]
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

  private hasAllRelatedDropsV2(
    notification: UserNotification,
    drops: Record<string, ApiDropV2>
  ): boolean {
    return this.getRelatedDropIds(notification).every(
      (dropId) => drops[dropId]
    );
  }

  private getAllRelatedWaveIds(notifications: UserNotification[]): string[] {
    return collections.distinct(
      notifications.flatMap((notification) => {
        const waveId = this.getRelatedWaveId(notification);
        return waveId ? [waveId] : [];
      })
    );
  }

  private getRelatedWaveId(notification: UserNotification): string | null {
    const notificationCause = notification.cause;
    switch (notificationCause) {
      case IdentityNotificationCause.IDENTITY_SUBSCRIBED:
      case IdentityNotificationCause.IDENTITY_REP:
      case IdentityNotificationCause.IDENTITY_NIC: {
        return null;
      }
      case IdentityNotificationCause.IDENTITY_MENTIONED:
      case IdentityNotificationCause.DROP_VOTED:
      case IdentityNotificationCause.DROP_REACTED:
      case IdentityNotificationCause.DROP_BOOSTED:
      case IdentityNotificationCause.DROP_QUOTED:
      case IdentityNotificationCause.DROP_REPLIED:
      case IdentityNotificationCause.WAVE_CREATED:
      case IdentityNotificationCause.ALL_DROPS:
      case IdentityNotificationCause.PRIORITY_ALERT: {
        return notification.data.wave_id;
      }
      default: {
        return assertUnreachable(notificationCause);
      }
    }
  }

  private getRelatedDropIds(notification: UserNotification): string[] {
    const notificationCause = notification.cause;
    switch (notificationCause) {
      case IdentityNotificationCause.IDENTITY_SUBSCRIBED:
      case IdentityNotificationCause.IDENTITY_REP:
      case IdentityNotificationCause.IDENTITY_NIC:
      case IdentityNotificationCause.WAVE_CREATED: {
        return [];
      }
      case IdentityNotificationCause.IDENTITY_MENTIONED:
      case IdentityNotificationCause.DROP_VOTED:
      case IdentityNotificationCause.DROP_REACTED:
      case IdentityNotificationCause.DROP_BOOSTED:
      case IdentityNotificationCause.ALL_DROPS:
      case IdentityNotificationCause.PRIORITY_ALERT: {
        return [notification.data.drop_id];
      }
      case IdentityNotificationCause.DROP_QUOTED: {
        return [
          notification.data.quote_drop_id,
          notification.data.quoted_drop_id
        ];
      }
      case IdentityNotificationCause.DROP_REPLIED: {
        return [
          notification.data.replied_drop_id,
          notification.data.reply_drop_id
        ];
      }
      default: {
        return assertUnreachable(notificationCause);
      }
    }
  }

  private mapToApiNotificationV2({
    notification,
    drops,
    profiles,
    waves,
    reactionRowsByDropId
  }: {
    notification: UserNotification;
    drops: Record<string, ApiDropV2>;
    profiles: Record<string, ApiIdentityOverview>;
    waves: Record<string, ApiWaveOverview>;
    reactionRowsByDropId: Map<string, DropReactionProfileRow[]>;
  }): ApiNotificationV2 {
    const apiNotification = this.mapToApiNotificationV2WithoutRelatedWave({
      notification,
      drops,
      profiles,
      reactionRowsByDropId
    });
    return this.withRelatedWave({
      notification,
      apiNotification,
      waves
    });
  }

  private mapToApiNotificationV2WithoutRelatedWave({
    notification,
    drops,
    profiles,
    reactionRowsByDropId
  }: {
    notification: UserNotification;
    drops: Record<string, ApiDropV2>;
    profiles: Record<string, ApiIdentityOverview>;
    reactionRowsByDropId: Map<string, DropReactionProfileRow[]>;
  }): ApiNotificationV2 {
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
          additional_context: this.getDropReactedAdditionalContextV2({
            dropId: data.drop_id,
            reaction: data.reaction,
            profiles,
            reactionRowsByDropId
          })
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

  private withRelatedWave({
    notification,
    apiNotification,
    waves
  }: {
    notification: UserNotification;
    apiNotification: ApiNotificationV2;
    waves: Record<string, ApiWaveOverview>;
  }): ApiNotificationV2 {
    const waveId = this.getRelatedWaveId(notification);
    if (!waveId) {
      return apiNotification;
    }
    const wave = waves[waveId];
    return wave ? { ...apiNotification, related_wave: wave } : apiNotification;
  }

  private getDropReactedAdditionalContextV2({
    dropId,
    reaction,
    profiles,
    reactionRowsByDropId
  }: {
    dropId: string;
    reaction: string;
    profiles: Record<string, ApiIdentityOverview>;
    reactionRowsByDropId: Map<string, DropReactionProfileRow[]>;
  }): DropReactedNotificationAdditionalContextV2 {
    const rows = reactionRowsByDropId.get(dropId) ?? [];
    const reactors = rows
      .filter((row) => row.reaction === reaction)
      .map((row) => profiles[row.profile_id])
      .filter((profile): profile is ApiIdentityOverview => !!profile)
      .map((profile) => ({
        handle: profile.handle,
        pfp: profile.pfp
      }));
    return {
      reaction,
      reactors
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

  public async getWaveSubscription(
    identityId: string,
    waveId: string
  ): Promise<ApiWaveNotificationPreferences> {
    const [subscriptionState, enabledGroups] = await Promise.all([
      this.identitySubscriptionsDb.getWaveSubscriptionState(identityId, waveId),
      this.waveGroupNotificationSubscriptionsDb.getEnabledGroups(
        identityId,
        waveId
      )
    ]);
    return {
      subscribed: subscriptionState.subscribed_to_all_drops,
      enabled_group_notifications: enabledGroups.map((group) =>
        enums.resolveOrThrow(ApiDropGroupMention, group)
      )
    };
  }

  public async updateWaveSubscription(
    identityId: string,
    waveId: string,
    request: ApiUpdateWaveNotificationPreferencesRequest
  ): Promise<ApiWaveNotificationPreferences> {
    const normalizedRequest =
      request.subscribed === undefined &&
      request.enabled_group_notifications === undefined
        ? { ...request, subscribed: true }
        : request;
    const mentionedGroups = (
      normalizedRequest.enabled_group_notifications ?? []
    ).map((group) => enums.resolveOrThrow(DropGroupMention, group));
    return this.identitySubscriptionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const [subscriptionState, existingEnabledGroups] = await Promise.all([
          this.identitySubscriptionsDb.getWaveSubscriptionState(
            identityId,
            waveId,
            connection
          ),
          this.waveGroupNotificationSubscriptionsDb.getEnabledGroups(
            identityId,
            waveId,
            connection
          )
        ]);

        if (
          normalizedRequest.subscribed === true &&
          subscriptionState.is_following &&
          !subscriptionState.subscribed_to_all_drops
        ) {
          const waveMembersCount =
            await this.identitySubscriptionsDb.countWaveSubscribersForUpdate(
              waveId,
              connection
            );
          const subscribersLimit =
            seizeSettings().all_drops_notifications_subscribers_limit;
          if (waveMembersCount >= subscribersLimit) {
            throw new BadRequestException(
              `Wave has too many subscribers (${waveMembersCount}). Max is ${subscribersLimit}.`
            );
          }
          await this.identitySubscriptionsDb.subscribeToAllDrops(
            identityId,
            waveId,
            connection
          );
        }

        if (normalizedRequest.subscribed === false) {
          await this.identitySubscriptionsDb.unsubscribeFromAllDrops(
            identityId,
            waveId,
            connection
          );
        }

        if (
          normalizedRequest.enabled_group_notifications !== undefined &&
          subscriptionState.is_following
        ) {
          await this.waveGroupNotificationSubscriptionsDb.replaceEnabledGroups(
            {
              identityId,
              waveId,
              mentionedGroups
            },
            connection
          );
        }

        const nextSubscribed =
          normalizedRequest.subscribed === true
            ? subscriptionState.is_following
              ? true
              : subscriptionState.subscribed_to_all_drops
            : normalizedRequest.subscribed === false
              ? false
              : subscriptionState.subscribed_to_all_drops;

        return {
          subscribed: nextSubscribed,
          enabled_group_notifications:
            (normalizedRequest.enabled_group_notifications !== undefined &&
            subscriptionState.is_following
              ? mentionedGroups
              : existingEnabledGroups
            ).map((group) => enums.resolveOrThrow(ApiDropGroupMention, group))
        };
      }
    );
  }

  public async clearWaveSubscription(
    identityId: string,
    waveId: string
  ): Promise<ApiWaveNotificationPreferences> {
    return this.updateWaveSubscription(identityId, waveId, {
      subscribed: false,
      enabled_group_notifications: []
    });
  }
}

export const notificationsApiService = new NotificationsApiService(
  userNotificationReader,
  userGroupsService,
  identityFetcher,
  dropsService,
  identityNotificationsDb,
  identitySubscriptionsDb,
  wavesApiDb,
  waveGroupNotificationSubscriptionsDb
);
