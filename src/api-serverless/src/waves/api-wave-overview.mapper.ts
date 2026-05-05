import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { WaveEntity, WaveType } from '@/entities/IWave';
import { WaveReaderMetricEntity } from '@/entities/IWaveReaderMetric';
import { collections } from '@/collections';
import { RequestContext } from '@/request.context';
import { ApiWaveOverview } from '@/api/generated/models/ApiWaveOverview';
import { ApiWaveOverviewContributor } from '@/api/generated/models/ApiWaveOverviewContributor';
import { ApiWaveOverviewContextProfileContext } from '@/api/generated/models/ApiWaveOverviewContextProfileContext';
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
      const contextProfileId = getWaveReadContextProfileId(
        ctx.authenticationContext
      );

      const [
        metricsByWaveId,
        groupIdsUserIsEligibleFor,
        displayByWaveId,
        subscribedActionsByWaveId,
        pinnedWaveIds,
        readerMetricsByWaveId,
        unreadDropsCountByWaveId,
        firstUnreadDropSerialNoByWaveId
      ] = await Promise.all([
        this.wavesApiDb.findWavesMetricsByWaveIds(waveIds, ctx),
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
          const overview: ApiWaveOverview = {
            id: wave.id,
            name: display?.name ?? wave.name,
            last_drop_time:
              metricsByWaveId[wave.id]?.latest_drop_timestamp ?? 0,
            created_at: wave.created_at,
            subscribers_count: metricsByWaveId[wave.id]?.subscribers_count ?? 0,
            has_competition: wave.type !== WaveType.CHAT,
            is_dm_wave: wave.is_direct_message === true
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
  identitySubscriptionsDb,
  userGroupsService,
  directMessageWaveDisplayService
);
