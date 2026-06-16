import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { DropMediaEntity, DropPartEntity } from '@/entities/IDrop';
import { WaveEntity, WaveType } from '@/entities/IWave';
import { WaveChatDropCooldownEntity } from '@/entities/IWaveChatDropCooldown';
import { WaveMetricEntity } from '@/entities/IWaveMetric';
import { WaveReaderMetricEntity } from '@/entities/IWaveReaderMetric';
import { collections } from '@/collections';
import { RequestContext } from '@/request.context';
import { dropsDb, DropsDb } from '@/drops/drops.db';
import { ApiDropMedia } from '@/api/generated/models/ApiDropMedia';
import { ApiWaveOverview } from '@/api/generated/models/ApiWaveOverview';
import { ApiWaveOverviewContributor } from '@/api/generated/models/ApiWaveOverviewContributor';
import { ApiWaveOverviewContextProfileContext } from '@/api/generated/models/ApiWaveOverviewContextProfileContext';
import { ApiWaveOverviewDescriptionDrop } from '@/api/generated/models/ApiWaveOverviewDescriptionDrop';
import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import { ApiProfileClassification } from '@/api/generated/models/ApiProfileClassification';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '@/api/identity-subscriptions/identity-subscriptions.db';
import {
  identityFetcher,
  IdentityFetcher
} from '@/api/identities/identity.fetcher';
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
import {
  mapWaveRepSummary,
  mapWaveScore
} from '@/api/waves/wave-score.api-mapper';
import { resolveNextDropAllowed } from '@/waves/wave-chat-slow-mode.helpers';

export function createUnknownWaveCreatorProfile({
  profileId,
  waveId
}: {
  profileId?: string | null;
  waveId: string;
}): ApiProfileMin {
  return {
    id: profileId ?? `unknown-wave-creator-${waveId}`,
    handle: 'Unknown profile',
    banner1_color: null,
    banner2_color: null,
    pfp: null,
    cic: 0,
    rep: 0,
    tdh: 0,
    xtdh: 0,
    xtdh_rate: 0,
    tdh_rate: 0,
    level: 0,
    classification: ApiProfileClassification.Pseudonym,
    sub_classification: null,
    archived: true,
    profile_wave_id: null,
    subscribed_actions: [],
    primary_address: '',
    active_main_stage_submission_ids: [],
    winner_main_stage_drop_ids: [],
    artist_of_prevote_cards: [],
    is_wave_creator: false
  };
}

export class ApiWaveOverviewMapper {
  constructor(
    private readonly wavesApiDb: WavesApiDb,
    private readonly dropsDb: DropsDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly directMessageWaveDisplayService: DirectMessageWaveDisplayService,
    private readonly identityFetcher: IdentityFetcher
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

      const contextProfileId = getWaveReadContextProfileId(
        ctx.authenticationContext
      );
      const groupIdsUserIsEligibleFor = contextProfileId
        ? await this.userGroupsService.getGroupsUserIsEligibleFor(
            contextProfileId,
            ctx.timer
          )
        : [];
      const requestedWaveIds = entities.map((wave) => wave.id);
      const parentWavesByChildWaveId =
        await this.wavesApiDb.findVisibleParentWavesByChildWaveIds(
          requestedWaveIds,
          groupIdsUserIsEligibleFor,
          ctx
        );
      const relatedEntities = collections.distinctBy(
        [...entities, ...Object.values(parentWavesByChildWaveId)],
        (wave) => wave.id
      );
      const waveIds = relatedEntities.map((wave) => wave.id);
      const descriptionDropIds = collections.distinct(
        relatedEntities.map((wave) => wave.description_drop_id)
      );
      const creatorIds = collections.distinct(
        relatedEntities
          .map((wave) => wave.created_by)
          .filter((profileId): profileId is string => !!profileId)
      );

      const [
        metricsByWaveId,
        descriptionDropPartOnesByDropId,
        descriptionDropPartOneMediaByDropId,
        displayByWaveId,
        subscribedActionsByWaveId,
        pinnedWaveIds,
        readerMetricsByWaveId,
        unreadDropsCountByWaveId,
        firstUnreadDropSerialNoByWaveId,
        chatDropCooldownsByWaveId,
        waveIdsWithVisibleSubwaves,
        profilesById
      ] = await Promise.all([
        this.wavesApiDb.findWavesMetricsByWaveIds(waveIds, ctx),
        this.dropsDb.getDropPartOnes(descriptionDropIds, ctx),
        this.dropsDb.getDropPartOneMedia(descriptionDropIds, ctx),
        contextProfileId
          ? this.directMessageWaveDisplayService.resolveWaveDisplayByWaveIdForContext(
              {
                waveEntities: relatedEntities,
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
          : Promise.resolve({} as Record<string, number | null>),
        contextProfileId
          ? this.wavesApiDb.findWaveChatDropCooldownsByWaveIds(
              {
                profileId: contextProfileId,
                waveIds
              },
              ctx
            )
          : Promise.resolve({} as Record<string, WaveChatDropCooldownEntity>),
        this.wavesApiDb.findWaveIdsWithVisibleSubwaves(
          waveIds,
          groupIdsUserIsEligibleFor,
          ctx
        ),
        creatorIds.length
          ? this.identityFetcher.getOverviewsByIds(creatorIds, ctx)
          : Promise.resolve({} as Record<string, ApiProfileMin>)
      ]);

      const overviewsByWaveId = relatedEntities.reduce(
        (acc, wave) => {
          acc[wave.id] = this.mapWaveOverview({
            wave,
            metrics: metricsByWaveId[wave.id],
            descriptionDropPartOnesByDropId,
            descriptionDropPartOneMediaByDropId,
            display: displayByWaveId[wave.id],
            contextProfileId,
            groupIdsUserIsEligibleFor,
            subscribedActions: subscribedActionsByWaveId[wave.id] ?? [],
            pinnedWaveIds,
            readerMetric: readerMetricsByWaveId[wave.id],
            unreadDropsCount: unreadDropsCountByWaveId[wave.id] ?? 0,
            firstUnreadDropSerialNo:
              firstUnreadDropSerialNoByWaveId[wave.id] ?? undefined,
            nextDropTimestamp:
              chatDropCooldownsByWaveId[wave.id]?.next_drop_timestamp,
            hasSubwaves: waveIdsWithVisibleSubwaves.has(wave.id),
            profilesById
          });
          return acc;
        },
        {} as Record<string, ApiWaveOverview>
      );

      return entities.reduce(
        (acc, wave) => {
          const overview = overviewsByWaveId[wave.id];
          const parentWave = parentWavesByChildWaveId[wave.id];
          if (parentWave) {
            overview.parent_wave = overviewsByWaveId[parentWave.id];
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

  private mapWaveOverview({
    wave,
    metrics,
    descriptionDropPartOnesByDropId,
    descriptionDropPartOneMediaByDropId,
    display,
    contextProfileId,
    groupIdsUserIsEligibleFor,
    subscribedActions,
    pinnedWaveIds,
    readerMetric,
    unreadDropsCount,
    firstUnreadDropSerialNo,
    nextDropTimestamp,
    hasSubwaves,
    profilesById
  }: {
    wave: WaveEntity;
    metrics?: WaveMetricEntity;
    descriptionDropPartOnesByDropId: Record<string, DropPartEntity>;
    descriptionDropPartOneMediaByDropId: Record<string, DropMediaEntity[]>;
    display?: WaveDisplayOverride;
    contextProfileId: string | null;
    groupIdsUserIsEligibleFor: string[];
    subscribedActions: ActivityEventAction[];
    pinnedWaveIds: Set<string>;
    readerMetric?: WaveReaderMetricEntity;
    unreadDropsCount: number;
    firstUnreadDropSerialNo?: number;
    nextDropTimestamp?: number;
    hasSubwaves: boolean;
    profilesById: Record<string, ApiProfileMin>;
  }): ApiWaveOverview {
    const pfp = resolveWavePictureOverride(wave.picture, display);
    const overview: ApiWaveOverview = {
      id: wave.id,
      name: display?.name ?? wave.name,
      creator: this.getProfileMinOrUnknown(wave, profilesById),
      last_drop_time: metrics?.latest_drop_timestamp ?? 0,
      created_at: wave.created_at,
      subscribers_count: metrics?.subscribers_count ?? 0,
      has_competition: wave.type !== WaveType.CHAT,
      is_dm_wave: wave.is_direct_message === true,
      links_disabled: wave.chat_links_disabled,
      description_drop: this.mapDescriptionDrop({
        part: descriptionDropPartOnesByDropId[wave.description_drop_id],
        media: descriptionDropPartOneMediaByDropId[wave.description_drop_id]
      }),
      total_drops_count: metrics?.drops_count ?? 0,
      is_private: wave.visibility_group_id !== null,
      wave_rep: mapWaveRepSummary(metrics),
      wave_score: mapWaveScore(metrics)
    };

    if (pfp) {
      overview.pfp = pfp;
    }
    if (hasSubwaves) {
      overview.has_subwaves = true;
    }
    if (wave.is_direct_message === true) {
      overview.contributors = this.mapDirectMessageContributors(display);
    }
    if (contextProfileId) {
      overview.context_profile_context = this.mapContextProfileContext({
        wave,
        groupIdsUserIsEligibleFor,
        subscribedActions,
        pinnedWaveIds,
        readerMetric,
        unreadDropsCount,
        firstUnreadDropSerialNo,
        contextProfileId,
        nextDropTimestamp
      });
    }

    return overview;
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
    firstUnreadDropSerialNo,
    contextProfileId,
    nextDropTimestamp
  }: {
    wave: WaveEntity;
    groupIdsUserIsEligibleFor: string[];
    subscribedActions: ActivityEventAction[];
    pinnedWaveIds: Set<string>;
    readerMetric?: WaveReaderMetricEntity;
    unreadDropsCount: number;
    firstUnreadDropSerialNo?: number;
    contextProfileId: string;
    nextDropTimestamp?: number;
  }): ApiWaveOverviewContextProfileContext {
    const nextDropAllowed = resolveNextDropAllowed({
      wave,
      authenticatedProfileId: contextProfileId,
      groupIdsUserIsEligibleFor,
      nextDropTimestamp
    });
    const result: ApiWaveOverviewContextProfileContext = {
      subscribed: subscribedActions.includes(ActivityEventAction.DROP_CREATED),
      pinned: pinnedWaveIds.has(wave.id),
      can_chat:
        wave.chat_enabled &&
        (wave.chat_group_id === null ||
          groupIdsUserIsEligibleFor.includes(wave.chat_group_id)) &&
        nextDropAllowed === undefined,
      unread_drops: unreadDropsCount,
      muted: readerMetric?.muted ?? false
    };

    if (nextDropAllowed !== undefined) {
      result.next_drop_allowed = nextDropAllowed;
    }

    if (firstUnreadDropSerialNo !== undefined) {
      result.first_unread_drop_serial_no = firstUnreadDropSerialNo;
    }

    return result;
  }

  private getProfileMinOrUnknown(
    wave: WaveEntity,
    profilesById: Record<string, ApiProfileMin>
  ): ApiProfileMin {
    const profileId = wave.created_by;
    if (!profileId) {
      return createUnknownWaveCreatorProfile({ waveId: wave.id });
    }
    return (
      profilesById[profileId] ??
      createUnknownWaveCreatorProfile({ profileId, waveId: wave.id })
    );
  }
}

export const apiWaveOverviewMapper = new ApiWaveOverviewMapper(
  wavesApiDb,
  dropsDb,
  identitySubscriptionsDb,
  userGroupsService,
  directMessageWaveDisplayService,
  identityFetcher
);
