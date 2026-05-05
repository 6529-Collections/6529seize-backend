import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { DropMediaEntity, DropPartEntity } from '@/entities/IDrop';
import { WaveEntity, WaveType } from '@/entities/IWave';
import { WaveReaderMetricEntity } from '@/entities/IWaveReaderMetric';
import { collections } from '@/collections';
import { RequestContext } from '@/request.context';
import { dropsDb, DropsDb } from '@/drops/drops.db';
import { ApiDropMedia } from '@/api/generated/models/ApiDropMedia';
import { ApiWaveOverview } from '@/api/generated/models/ApiWaveOverview';
import { ApiWaveOverviewContributor } from '@/api/generated/models/ApiWaveOverviewContributor';
import { ApiWaveOverviewContextProfileContext } from '@/api/generated/models/ApiWaveOverviewContextProfileContext';
import { ApiWaveOverviewDescriptionDrop } from '@/api/generated/models/ApiWaveOverviewDescriptionDrop';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '@/api/identity-subscriptions/identity-subscriptions.db';
import {
  userGroupsService,
  UserGroupsService
} from '@/api/community-members/user-groups.service';
import {
  directMessageWaveDisplayService,
  DirectMessageWaveDisplayService,
  resolveWavePictureOverride,
  WaveDisplayOverride
} from '@/api/waves/direct-message-wave-display.service';
import { getWaveReadContextProfileId } from '@/api/waves/wave-access.helpers';
import { wavesApiDb, WavesApiDb } from '@/api/waves/waves.api.db';

export class ApiWaveOverviewMapper {
  constructor(
    private readonly wavesApiDb: WavesApiDb,
    private readonly dropsDb: DropsDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly directMessageWaveDisplayService: DirectMessageWaveDisplayService
  ) {}

  public async mapWaves(
    waveEntities: WaveEntity[],
    ctx: RequestContext
  ): Promise<Record<string, ApiWaveOverview>> {
    const timerKey = `${this.constructor.name}->mapWaves`;
    ctx.timer?.start(timerKey);
    try {
      const entities = collections.distinctBy(waveEntities, (wave) => wave.id);
      if (!entities.length) {
        return {};
      }

      const waveIds = entities.map((wave) => wave.id);
      const descriptionDropIds = collections.distinct(
        entities.map((wave) => wave.description_drop_id)
      );
      const contextProfileId = getWaveReadContextProfileId(
        ctx.authenticationContext
      );

      const [
        metricsByWaveId,
        descriptionDropPartOnesByDropId,
        descriptionDropPartOneMediaByDropId,
        groupIdsUserIsEligibleFor,
        displayByWaveId,
        subscribedActionsByWaveId,
        pinnedWaveIds,
        readerMetricsByWaveId,
        unreadDropsCountByWaveId,
        firstUnreadDropSerialNoByWaveId
      ] = await Promise.all([
        this.wavesApiDb.findWavesMetricsByWaveIds(waveIds, ctx),
        this.dropsDb.getDropPartOnes(descriptionDropIds, ctx),
        this.dropsDb.getDropPartOneMedia(descriptionDropIds, ctx),
        contextProfileId
          ? this.userGroupsService.getGroupsUserIsEligibleFor(
              contextProfileId,
              ctx.timer
            )
          : Promise.resolve([]),
        contextProfileId
          ? this.directMessageWaveDisplayService.resolveWaveDisplayByWaveIdForContext(
              {
                waveEntities: entities,
                contextProfileId
              },
              ctx.connection
            )
          : Promise.resolve({} as Record<string, WaveDisplayOverride>),
        contextProfileId
          ? this.identitySubscriptionsDb.findIdentitySubscriptionActionsOfTargets(
              {
                subscriber_id: contextProfileId,
                target_ids: waveIds,
                target_type: ActivityEventTargetType.WAVE
              },
              ctx.connection
            )
          : Promise.resolve({} as Record<string, ActivityEventAction[]>),
        contextProfileId
          ? this.wavesApiDb.whichOfWavesArePinnedByGivenProfile(
              {
                waveIds,
                profileId: contextProfileId
              },
              ctx
            )
          : Promise.resolve(new Set<string>()),
        contextProfileId
          ? this.wavesApiDb.findWaveReaderMetricsByWaveIds(
              {
                waveIds,
                readerId: contextProfileId
              },
              ctx
            )
          : Promise.resolve({} as Record<string, WaveReaderMetricEntity>),
        contextProfileId
          ? this.wavesApiDb.findIdentityUnreadDropsCountByWaveId(
              {
                identityId: contextProfileId,
                waveIds
              },
              ctx
            )
          : Promise.resolve({} as Record<string, number>),
        contextProfileId
          ? this.wavesApiDb.findFirstUnreadDropSerialNoByWaveId(
              {
                identityId: contextProfileId,
                waveIds
              },
              ctx
            )
          : Promise.resolve({} as Record<string, number | null>)
      ]);

      return entities.reduce(
        (acc, wave) => {
          const display = displayByWaveId[wave.id];
          const pfp = resolveWavePictureOverride(wave.picture, display);
          const metrics = metricsByWaveId[wave.id];
          const overview: ApiWaveOverview = {
            id: wave.id,
            name: display?.name ?? wave.name,
            last_drop_time: metrics?.latest_drop_timestamp ?? 0,
            created_at: wave.created_at,
            subscribers_count: metrics?.subscribers_count ?? 0,
            has_competition: wave.type !== WaveType.CHAT,
            is_dm_wave: wave.is_direct_message === true,
            description_drop: this.mapDescriptionDrop({
              part: descriptionDropPartOnesByDropId[wave.description_drop_id],
              media:
                descriptionDropPartOneMediaByDropId[wave.description_drop_id]
            }),
            total_drops_count: metrics?.drops_count ?? 0,
            is_private: wave.visibility_group_id !== null
          };

          if (pfp) {
            overview.pfp = pfp;
          }
          if (wave.is_direct_message === true) {
            overview.contributors = this.mapDirectMessageContributors(display);
          }
          if (contextProfileId) {
            overview.context_profile_context = this.mapContextProfileContext({
              wave,
              groupIdsUserIsEligibleFor,
              subscribedActions: subscribedActionsByWaveId[wave.id] ?? [],
              pinnedWaveIds,
              readerMetric: readerMetricsByWaveId[wave.id],
              unreadDropsCount: unreadDropsCountByWaveId[wave.id] ?? 0,
              firstUnreadDropSerialNo:
                firstUnreadDropSerialNoByWaveId[wave.id] ?? undefined
            });
          }

          acc[wave.id] = overview;
          return acc;
        },
        {} as Record<string, ApiWaveOverview>
      );
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  private mapDirectMessageContributors(
    display: WaveDisplayOverride | undefined
  ): ApiWaveOverviewContributor[] {
    return (
      display?.contributors?.map((contributor) => ({
        handle: contributor.handle,
        pfp: contributor.pfp
      })) ?? []
    );
  }

  private mapDescriptionDrop({
    part,
    media
  }: {
    part?: DropPartEntity;
    media?: DropMediaEntity[];
  }): ApiWaveOverviewDescriptionDrop {
    const result: ApiWaveOverviewDescriptionDrop = {};

    if (part?.content !== null && part?.content !== undefined) {
      result.contents = part.content;
    }

    if (media?.length) {
      result.media = this.mapDescriptionDropMedia(media);
    }

    return result;
  }

  private mapDescriptionDropMedia(media: DropMediaEntity[]): ApiDropMedia[] {
    return media.map((item) => ({
      url: item.url,
      mime_type: item.mime_type
    }));
  }

  private mapContextProfileContext({
    wave,
    groupIdsUserIsEligibleFor,
    subscribedActions,
    pinnedWaveIds,
    readerMetric,
    unreadDropsCount,
    firstUnreadDropSerialNo
  }: {
    wave: WaveEntity;
    groupIdsUserIsEligibleFor: string[];
    subscribedActions: ActivityEventAction[];
    pinnedWaveIds: Set<string>;
    readerMetric?: WaveReaderMetricEntity;
    unreadDropsCount: number;
    firstUnreadDropSerialNo?: number;
  }): ApiWaveOverviewContextProfileContext {
    const result: ApiWaveOverviewContextProfileContext = {
      subscribed: subscribedActions.includes(ActivityEventAction.DROP_CREATED),
      pinned: pinnedWaveIds.has(wave.id),
      can_chat:
        wave.chat_enabled &&
        (wave.chat_group_id === null ||
          groupIdsUserIsEligibleFor.includes(wave.chat_group_id)),
      unread_drops: unreadDropsCount,
      muted: readerMetric?.muted ?? false
    };

    if (firstUnreadDropSerialNo !== undefined) {
      result.first_unread_drop_serial_no = firstUnreadDropSerialNo;
    }

    return result;
  }
}

export const apiWaveOverviewMapper = new ApiWaveOverviewMapper(
  wavesApiDb,
  dropsDb,
  identitySubscriptionsDb,
  userGroupsService,
  directMessageWaveDisplayService
);
