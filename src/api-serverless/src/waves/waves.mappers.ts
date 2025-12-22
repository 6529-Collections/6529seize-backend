import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import {
  ParticipationRequiredMedia,
  WaveCreditType,
  WaveDecisionPauseEntity,
  WaveEntity,
  WaveRequiredMetadataItemType,
  WaveType
} from '../../../entities/IWave';
import { WaveDropperMetricEntity } from '../../../entities/IWaveDropperMetric';
import { WaveMetricEntity } from '../../../entities/IWaveMetric';
import { WaveReaderMetricEntity } from '../../../entities/IWaveReaderMetric';
import { RequestContext } from '../../../request.context';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { dropsService } from '../drops/drops.api.service';
import { ApiCreateNewWave } from '../generated/models/ApiCreateNewWave';
import { ApiDrop } from '../generated/models/ApiDrop';
import { ApiGroup } from '../generated/models/ApiGroup';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { ApiUpdateWaveRequest } from '../generated/models/ApiUpdateWaveRequest';
import { ApiWave } from '../generated/models/ApiWave';
import { ApiWaveChatConfig } from '../generated/models/ApiWaveChatConfig';
import { ApiWaveConfig } from '../generated/models/ApiWaveConfig';
import { ApiWaveContributorOverview } from '../generated/models/ApiWaveContributorOverview';
import { ApiWaveCreditType as WaveCreditTypeApi } from '../generated/models/ApiWaveCreditType';
import { ApiWaveMetadataType } from '../generated/models/ApiWaveMetadataType';
import { ApiWaveMetrics } from '../generated/models/ApiWaveMetrics';
import { ApiWaveParticipationConfig } from '../generated/models/ApiWaveParticipationConfig';
import { ApiWaveParticipationRequirement } from '../generated/models/ApiWaveParticipationRequirement';
import { ApiWaveScope } from '../generated/models/ApiWaveScope';
import { ApiWaveSubscriptionTargetAction } from '../generated/models/ApiWaveSubscriptionTargetAction';
import { ApiWaveType as WaveTypeApi } from '../generated/models/ApiWaveType';
import { ApiWaveVisibilityConfig } from '../generated/models/ApiWaveVisibilityConfig';
import { ApiWaveVotingConfig } from '../generated/models/ApiWaveVotingConfig';
import {
  identityFetcher,
  IdentityFetcher
} from '../identities/identity.fetcher';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import { InsertWaveEntity, wavesApiDb, WavesApiDb } from './waves.api.db';
import { enums } from '../../../enums';
import { collections } from '../../../collections';

export class WavesMappers {
  constructor(
    private readonly identityFetcher: IdentityFetcher,
    private readonly userGroupsService: UserGroupsService,
    private readonly wavesApiDb: WavesApiDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb
  ) {}

  public async createWaveToNewWaveEntity({
    id,
    serial_no,
    created_at,
    updated_at,
    request,
    created_by,
    descriptionDropId,
    nextDecisionTime,
    isDirectMessage
  }: {
    id: string;
    serial_no: number | null;
    created_at: number;
    updated_at: number | null;
    request: ApiCreateNewWave | ApiUpdateWaveRequest;
    created_by: string;
    descriptionDropId: string;
    nextDecisionTime: number | null;
    isDirectMessage: boolean;
  }): Promise<InsertWaveEntity> {
    let creditorId = request.voting.creditor_id;
    if (creditorId) {
      creditorId = await identityFetcher.getProfileIdByIdentityKeyOrThrow(
        {
          identityKey: creditorId
        },
        {}
      );
    }
    return {
      id,
      serial_no,
      created_at,
      updated_at,
      chat_enabled: request.chat.enabled,
      name: request.name,
      description_drop_id: descriptionDropId,
      picture: request.picture,
      created_by,
      voting_group_id: request.voting.scope.group_id,
      admin_group_id: request.wave.admin_group?.group_id ?? null,
      voting_credit_type: enums.resolveOrThrow(
        WaveCreditType,
        request.voting.credit_type
      ),
      voting_credit_category: request.voting.credit_category,
      voting_credit_creditor: creditorId,
      voting_signature_required: request.voting.signature_required,
      voting_period_start: request.voting.period?.min ?? null,
      voting_period_end: request.voting.period?.max ?? null,
      visibility_group_id: request.visibility.scope.group_id,
      participation_group_id: request.participation.scope.group_id,
      chat_group_id: request.chat.scope.group_id,
      participation_max_applications_per_participant:
        request.participation.no_of_applications_allowed_per_participant,
      participation_required_metadata:
        request.participation.required_metadata.map((md) => ({
          name: md.name,
          type: enums.resolveOrThrow(
            WaveRequiredMetadataItemType,
            md.type.toString()
          )
        })),
      participation_required_media: request.participation.required_media.map(
        (it) => enums.resolveOrThrow(ParticipationRequiredMedia, it)
      ),
      participation_period_start: request.participation.period?.min ?? null,
      participation_period_end: request.participation.period?.max ?? null,
      type: enums.resolveOrThrow(WaveType, request.wave.type),
      winning_min_threshold: request.wave.winning_thresholds?.min ?? null,
      winning_max_threshold: request.wave.winning_thresholds?.max ?? null,
      max_winners: request.wave.max_winners ?? null,
      time_lock_ms: request.wave.time_lock_ms ?? null,
      decisions_strategy: request.wave.decisions_strategy ?? null,
      next_decision_time: nextDecisionTime,
      participation_signature_required:
        request.participation.signature_required,
      participation_terms: request.participation.terms,
      admin_drop_deletion_enabled: request.wave.admin_drop_deletion_enabled,
      forbid_negative_votes: request.voting.forbid_negative_votes,
      is_direct_message: isDirectMessage
    };
  }

  public async waveEntityToApiWave(
    {
      waveEntity,
      groupIdsUserIsEligibleFor,
      noRightToVote,
      noRightToParticipate
    }: {
      waveEntity: WaveEntity;
      groupIdsUserIsEligibleFor: string[];
      noRightToVote: boolean;
      noRightToParticipate: boolean;
    },
    ctx: RequestContext
  ): Promise<ApiWave> {
    return this.waveEntitiesToApiWaves(
      {
        waveEntities: [waveEntity],
        groupIdsUserIsEligibleFor,
        noRightToVote,
        noRightToParticipate
      },
      ctx
    ).then((waves) => waves[0]);
  }

  public async waveEntitiesToApiWaves(
    {
      waveEntities,
      groupIdsUserIsEligibleFor,
      noRightToVote,
      noRightToParticipate
    }: {
      waveEntities: WaveEntity[];
      groupIdsUserIsEligibleFor: string[];
      noRightToVote: boolean;
      noRightToParticipate: boolean;
    },
    ctx: RequestContext
  ): Promise<ApiWave[]> {
    const {
      contributors,
      profiles,
      curations,
      creationDrops,
      subscribedActions,
      metrics,
      authenticatedUserMetrics,
      authenticatedUserReaderMetrics,
      yourParticipationDropsCountByWaveId,
      yourUnreadDropsCountByWaveId,
      firstUnreadDropSerialNoByWaveId,
      wavePauses,
      pinnedWaveIds
    } = await this.getRelatedData(waveEntities, groupIdsUserIsEligibleFor, ctx);
    return waveEntities.map<ApiWave>((waveEntity) =>
      this.mapWaveEntityToApiWave({
        waveEntity,
        profiles,
        contributors,
        creationDrops,
        curations,
        subscribedActions,
        noRightToVote,
        groupIdsUserIsEligibleFor,
        noRightToParticipate,
        metrics,
        authenticatedUserMetrics,
        authenticatedUserReaderMetrics,
        yourParticipationDropsCountByWaveId,
        yourUnreadDropsCountByWaveId,
        firstUnreadDropSerialNoByWaveId,
        wavePauses,
        pinnedWaveIds
      })
    );
  }

  private mapWaveEntityToApiWave({
    waveEntity,
    profiles,
    contributors,
    creationDrops,
    curations,
    subscribedActions,
    noRightToVote,
    groupIdsUserIsEligibleFor,
    noRightToParticipate,
    metrics,
    authenticatedUserMetrics,
    authenticatedUserReaderMetrics,
    yourParticipationDropsCountByWaveId,
    yourUnreadDropsCountByWaveId,
    firstUnreadDropSerialNoByWaveId,
    wavePauses,
    pinnedWaveIds
  }: {
    waveEntity: WaveEntity;
    profiles: Record<string, ApiProfileMin>;
    contributors: Record<
      string,
      {
        contributor_identity: string;
        contributor_pfp: string;
      }[]
    >;
    creationDrops: Record<string, ApiDrop>;
    curations: Record<string, ApiGroup>;
    subscribedActions: Record<string, ApiWaveSubscriptionTargetAction[]>;
    noRightToVote: boolean;
    groupIdsUserIsEligibleFor: string[];
    noRightToParticipate: boolean;
    metrics: Record<string, WaveMetricEntity>;
    authenticatedUserMetrics: Record<string, WaveDropperMetricEntity>;
    authenticatedUserReaderMetrics: Record<string, WaveReaderMetricEntity>;
    yourParticipationDropsCountByWaveId: Record<string, number>;
    yourUnreadDropsCountByWaveId: Record<string, number>;
    firstUnreadDropSerialNoByWaveId: Record<string, number | null>;
    wavePauses: Record<string, WaveDecisionPauseEntity[]>;
    pinnedWaveIds: Set<string>;
  }): ApiWave {
    const contributorsOverview: ApiWaveContributorOverview[] =
      contributors[waveEntity.id]?.map((it) => ({
        contributor_identity: it.contributor_identity,
        contributor_pfp: it.contributor_pfp
      })) ?? [];
    const creationDrop: ApiDrop = creationDrops[waveEntity.description_drop_id];
    const votingScope: ApiWaveScope = {
      group: curations[waveEntity.voting_group_id!] ?? null
    };
    const voteCreditor: ApiProfileMin | null =
      profiles[waveEntity.voting_credit_creditor!] ?? null;
    const authenticatedUserEligibleToVote =
      !noRightToVote &&
      (!waveEntity.voting_group_id ||
        groupIdsUserIsEligibleFor.includes(waveEntity.voting_group_id));
    const voting: ApiWaveVotingConfig = {
      scope: votingScope,
      credit_type: enums.resolveOrThrow(
        WaveCreditTypeApi,
        waveEntity.voting_credit_type
      ),
      credit_category: waveEntity.voting_credit_category,
      creditor: voteCreditor,
      signature_required: waveEntity.voting_signature_required,
      period: {
        min: waveEntity.voting_period_start,
        max: waveEntity.voting_period_end
      },
      authenticated_user_eligible: authenticatedUserEligibleToVote,
      forbid_negative_votes: waveEntity.forbid_negative_votes
    };
    const visibility: ApiWaveVisibilityConfig = {
      scope: {
        group: curations[waveEntity.visibility_group_id!] ?? null
      }
    };
    const authenticatedUserEligibleToParticipate =
      !noRightToParticipate &&
      (!waveEntity.participation_group_id ||
        groupIdsUserIsEligibleFor.includes(waveEntity.participation_group_id));
    const participation: ApiWaveParticipationConfig = {
      scope: {
        group: curations[waveEntity.participation_group_id!] ?? null
      },
      no_of_applications_allowed_per_participant:
        waveEntity.participation_max_applications_per_participant,
      required_metadata: waveEntity.participation_required_metadata.map(
        (it) => ({
          name: it.name,
          type: enums.resolveOrThrow(ApiWaveMetadataType, it.type)
        })
      ),
      required_media: waveEntity.participation_required_media.map((it) =>
        enums.resolveOrThrow(ApiWaveParticipationRequirement, it)
      ),
      signature_required: waveEntity.participation_signature_required,
      period: {
        min: waveEntity.participation_period_start,
        max: waveEntity.participation_period_end
      },
      authenticated_user_eligible: authenticatedUserEligibleToParticipate,
      terms: waveEntity.participation_terms
    };
    const chat: ApiWaveChatConfig = {
      scope: {
        group: curations[waveEntity.chat_group_id!] ?? null
      },
      enabled: waveEntity.chat_enabled,
      authenticated_user_eligible:
        (waveEntity.chat_group_id === null ||
          groupIdsUserIsEligibleFor.includes(waveEntity.chat_group_id)) &&
        waveEntity.chat_enabled
    };
    const authenticatedUserEligibleForAdmin = !!(
      waveEntity.admin_group_id &&
      groupIdsUserIsEligibleFor.includes(waveEntity.admin_group_id)
    );
    const waveConf: ApiWaveConfig = {
      type: enums.resolveOrThrow(WaveTypeApi, waveEntity.type),
      winning_thresholds: {
        min: waveEntity.winning_min_threshold,
        max: waveEntity.winning_max_threshold
      },
      max_winners: waveEntity.max_winners,
      time_lock_ms: waveEntity.time_lock_ms,
      admin_group: {
        group: curations[waveEntity.admin_group_id!] ?? null
      },
      authenticated_user_eligible_for_admin: authenticatedUserEligibleForAdmin,
      decisions_strategy: waveEntity.decisions_strategy,
      next_decision_time: waveEntity.next_decision_time,
      admin_drop_deletion_enabled: waveEntity.admin_drop_deletion_enabled
    };
    const waveMetrics = metrics[waveEntity.id];
    const waveAuthenticatedUserMetrics =
      authenticatedUserMetrics[waveEntity.id];
    const waveAuthenticatedUserReaderMetrics =
      authenticatedUserReaderMetrics[waveEntity.id];

    const apiWaveMetrics: ApiWaveMetrics = {
      drops_count: waveMetrics.drops_count,
      subscribers_count: waveMetrics.subscribers_count,
      latest_drop_timestamp: waveMetrics.latest_drop_timestamp,
      your_drops_count: waveAuthenticatedUserMetrics?.drops_count,
      your_latest_drop_timestamp:
        waveAuthenticatedUserMetrics?.latest_drop_timestamp,
      your_participation_drops_count:
        yourParticipationDropsCountByWaveId[waveEntity.id] ?? 0,
      your_unread_drops_count: yourUnreadDropsCountByWaveId[waveEntity.id] ?? 0,
      first_unread_drop_serial_no:
        firstUnreadDropSerialNoByWaveId[waveEntity.id] ?? undefined,
      your_latest_read_timestamp:
        waveAuthenticatedUserReaderMetrics?.latest_read_timestamp ?? 0,
      muted: waveAuthenticatedUserReaderMetrics?.muted ?? false
    };
    const pauses = (wavePauses[waveEntity.id] ?? [])
      .sort((a, d) => a.start_time - d.start_time)
      .map((entity) => ({
        id: entity.id,
        start_time: +entity.start_time,
        end_time: +entity.end_time
      }));
    return {
      id: waveEntity.id,
      name: waveEntity.name,
      picture: waveEntity.picture,
      serial_no: waveEntity.serial_no,
      author: profiles[waveEntity.created_by],
      contributors_overview: contributorsOverview,
      description_drop: creationDrop,
      created_at: waveEntity.created_at,
      voting: voting,
      visibility: visibility,
      participation: participation,
      chat: chat,
      wave: waveConf,
      subscribed_actions: subscribedActions[waveEntity.id] ?? [],
      metrics: apiWaveMetrics,
      pauses,
      pinned: pinnedWaveIds.has(waveEntity.id)
    };
  }

  private async getRelatedData(
    waveEntities: WaveEntity[],
    groupIdsUserIsEligibleFor: string[],
    ctx: RequestContext
  ): Promise<{
    contributors: Record<
      string,
      { contributor_identity: string; contributor_pfp: string }[]
    >;
    profiles: Record<string, ApiProfileMin>;
    curations: Record<string, ApiGroup>;
    creationDrops: Record<string, ApiDrop>;
    subscribedActions: Record<string, ApiWaveSubscriptionTargetAction[]>;
    metrics: Record<string, WaveMetricEntity>;
    authenticatedUserMetrics: Record<string, WaveDropperMetricEntity>;
    authenticatedUserReaderMetrics: Record<string, WaveReaderMetricEntity>;
    yourParticipationDropsCountByWaveId: Record<string, number>;
    yourUnreadDropsCountByWaveId: Record<string, number>;
    firstUnreadDropSerialNoByWaveId: Record<string, number | null>;
    wavePauses: Record<string, WaveDecisionPauseEntity[]>;
    pinnedWaveIds: Set<string>;
  }> {
    ctx.timer?.start('wavesMappers->getRelatedData');
    const waveIds = waveEntities.map((it) => it.id);
    const authenticatedUserId = ctx.authenticationContext?.getActingAsId();
    ctx.timer?.start('dropsService->findDropsByIdsOrThrow');
    ctx.timer?.start(
      'identitySubscriptionsDb->findIdentitySubscriptionActionsOfTargets'
    );
    const [
      curationEntities,
      metrics,
      authenticatedUserMetrics,
      authenticatedUserReaderMetrics,
      contributorsOverViews,
      creationDropsByDropId,
      subscribedActions,
      yourParticipationDropsCountByWaveId,
      yourUnreadDropsCountByWaveId,
      firstUnreadDropSerialNoByWaveId,
      wavePauses,
      pinnedWaveIds
    ] = await Promise.all([
      this.userGroupsService.getByIds(
        waveEntities
          .map(
            (waveEntity) =>
              [
                waveEntity.visibility_group_id,
                waveEntity.participation_group_id,
                waveEntity.voting_group_id,
                waveEntity.admin_group_id,
                waveEntity.chat_group_id
              ].filter((id) => id !== null) as string[]
          )
          .flat(),
        ctx
      ),
      this.wavesApiDb.findWavesMetricsByWaveIds(waveIds, ctx),
      authenticatedUserId
        ? this.wavesApiDb.findWaveDropperMetricsByWaveIds(
            { waveIds, dropperId: authenticatedUserId },
            ctx
          )
        : Promise.resolve({} as Record<string, WaveDropperMetricEntity>),
      authenticatedUserId
        ? this.wavesApiDb.findWaveReaderMetricsByWaveIds(
            { waveIds, readerId: authenticatedUserId },
            ctx
          )
        : Promise.resolve({} as Record<string, WaveReaderMetricEntity>),
      this.wavesApiDb.getWavesContributorsOverviews(waveIds, ctx),

      dropsService
        .findDropsByIdsOrThrow(
          collections.distinct(
            waveEntities.map((it) => it.description_drop_id)
          ),
          ctx.authenticationContext,
          ctx.connection
        )
        .then((drops) => {
          ctx.timer?.stop('dropsService->findDropsByIdsOrThrow');
          return drops;
        }),
      authenticatedUserId
        ? this.identitySubscriptionsDb
            .findIdentitySubscriptionActionsOfTargets(
              {
                subscriber_id: authenticatedUserId,
                target_ids: waveIds,
                target_type: ActivityEventTargetType.WAVE
              },
              ctx.connection
            )
            .then((result) => {
              ctx.timer?.stop(
                'identitySubscriptionsDb->findIdentitySubscriptionActionsOfTargets'
              );
              return result;
            })
        : Promise.resolve({} as Record<string, ActivityEventAction[]>),
      authenticatedUserId
        ? this.wavesApiDb.findIdentityParticipationDropsCountByWaveId(
            {
              identityId: authenticatedUserId,
              waveIds
            },
            ctx
          )
        : Promise.resolve({} as Record<string, number>),
      authenticatedUserId
        ? this.wavesApiDb.findIdentityUnreadDropsCountByWaveId(
            {
              identityId: authenticatedUserId,
              waveIds
            },
            ctx
          )
        : Promise.resolve({} as Record<string, number>),
      authenticatedUserId
        ? this.wavesApiDb.findFirstUnreadDropSerialNoByWaveId(
            {
              identityId: authenticatedUserId,
              waveIds
            },
            ctx
          )
        : Promise.resolve({} as Record<string, number | null>),
      this.wavesApiDb.getWavesPauses(waveIds, ctx),
      this.wavesApiDb.whichOfWavesArePinnedByGivenProfile(
        {
          waveIds,
          profileId: authenticatedUserId
        },
        ctx
      )
    ]);
    const profileIds = collections.distinct([
      ...waveEntities
        .map(
          (waveEntity) =>
            [waveEntity.created_by, waveEntity.voting_credit_creditor].filter(
              (id) => id !== null
            ) as string[]
        )
        .flat(),
      ...curationEntities.map((curationEntity) => curationEntity.created_by)
    ]);
    const profileMins = await this.identityFetcher.getOverviewsByIds(
      profileIds,
      ctx
    );
    const curations: Record<string, ApiGroup> = curationEntities.reduce(
      (acc, curationEntity) => {
        const isHidden =
          curationEntity.is_private &&
          !groupIdsUserIsEligibleFor.includes(curationEntity.id) &&
          curationEntity.created_by !== authenticatedUserId;
        if (isHidden) {
          acc[curationEntity.id] = {
            is_hidden: true
          };
        } else {
          acc[curationEntity.id] = {
            id: curationEntity.id,
            name: curationEntity.name,
            author: profileMins[curationEntity.created_by],
            created_at: new Date(curationEntity.created_at).getTime(),
            is_hidden: false,
            is_direct_message: curationEntity.is_direct_message
          };
        }
        return acc;
      },
      {} as Record<string, ApiGroup>
    );
    ctx.timer?.stop('wavesMappers->getRelatedData');
    return {
      contributors: contributorsOverViews,
      profiles: profileMins,
      curations,
      creationDrops: creationDropsByDropId,
      subscribedActions: Object.entries(subscribedActions).reduce(
        (acc, [id, actions]) => {
          acc[id] = actions.map((it) =>
            enums.resolveOrThrow(ApiWaveSubscriptionTargetAction, it)
          );
          return acc;
        },
        {} as Record<string, ApiWaveSubscriptionTargetAction[]>
      ),
      metrics,
      authenticatedUserMetrics,
      authenticatedUserReaderMetrics,
      yourParticipationDropsCountByWaveId,
      yourUnreadDropsCountByWaveId,
      firstUnreadDropSerialNoByWaveId,
      wavePauses,
      pinnedWaveIds
    };
  }
}

export const wavesMappers = new WavesMappers(
  identityFetcher,
  userGroupsService,
  wavesApiDb,
  identitySubscriptionsDb
);
