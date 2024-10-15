import { ApiCreateNewWave } from '../generated/models/ApiCreateNewWave';
import { InsertWaveEntity, wavesApiDb, WavesApiDb } from './waves.api.db';
import { distinct, resolveEnumOrThrow } from '../../../helpers';
import {
  ParticipationRequiredMedia,
  WaveCreditScopeType,
  WaveCreditType,
  WaveEntity,
  WaveRequiredMetadataItemType,
  WaveType
} from '../../../entities/IWave';
import { ApiWave } from '../generated/models/ApiWave';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { ApiWaveCreditType as WaveCreditTypeApi } from '../generated/models/ApiWaveCreditType';
import { ApiWaveCreditScope as WaveCreditScopeApi } from '../generated/models/ApiWaveCreditScope';
import { ApiWaveType as WaveTypeApi } from '../generated/models/ApiWaveType';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { ApiGroup } from '../generated/models/ApiGroup';
import { ApiWaveParticipationRequirement } from '../generated/models/ApiWaveParticipationRequirement';
import { ApiDrop } from '../generated/models/ApiDrop';
import { ApiWaveVotingConfig } from '../generated/models/ApiWaveVotingConfig';
import { ApiWaveScope } from '../generated/models/ApiWaveScope';
import { ApiWaveContributorOverview } from '../generated/models/ApiWaveContributorOverview';
import { ApiWaveVisibilityConfig } from '../generated/models/ApiWaveVisibilityConfig';
import { ApiWaveParticipationConfig } from '../generated/models/ApiWaveParticipationConfig';
import { ApiWaveConfig } from '../generated/models/ApiWaveConfig';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import { ApiWaveSubscriptionTargetAction } from '../generated/models/ApiWaveSubscriptionTargetAction';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import {
  profilesApiService,
  ProfilesApiService
} from '../profiles/profiles.api.service';
import { WaveMetricEntity } from '../../../entities/IWaveMetric';
import { ApiWaveMetrics } from '../generated/models/ApiWaveMetrics';
import { RequestContext } from '../../../request.context';
import { dropsService } from '../drops/drops.api.service';
import { ApiUpdateWaveRequest } from '../generated/models/ApiUpdateWaveRequest';
import { ApiWaveMetadataType } from '../generated/models/ApiWaveMetadataType';
import { WaveDropperMetricEntity } from '../../../entities/IWaveDropperMetric';
import { ApiWaveChatConfig } from '../generated/models/ApiWaveChatConfig';

export class WavesMappers {
  constructor(
    private readonly profilesApiService: ProfilesApiService,
    private readonly userGroupsService: UserGroupsService,
    private readonly wavesApiDb: WavesApiDb,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb
  ) {}

  public createWaveToNewWaveEntity(
    id: string,
    serial_no: number | null,
    created_at: number,
    updated_at: number | null,
    createWaveRequest: ApiCreateNewWave | ApiUpdateWaveRequest,
    created_by: string,
    descriptionDropId: string
  ): InsertWaveEntity {
    return {
      id,
      serial_no,
      created_at,
      updated_at,
      chat_enabled: createWaveRequest.chat.enabled,
      name: createWaveRequest.name,
      description_drop_id: descriptionDropId,
      picture: createWaveRequest.picture,
      created_by,
      voting_group_id: createWaveRequest.voting.scope.group_id,
      admin_group_id: createWaveRequest.wave.admin_group?.group_id ?? null,
      voting_credit_type: resolveEnumOrThrow(
        WaveCreditType,
        createWaveRequest.voting.credit_type
      ),
      voting_credit_scope_type: resolveEnumOrThrow(
        WaveCreditScopeType,
        createWaveRequest.voting.credit_scope
      ),
      voting_credit_category: createWaveRequest.voting.credit_category,
      voting_credit_creditor: createWaveRequest.voting.creditor_id,
      voting_signature_required: createWaveRequest.voting.signature_required,
      voting_period_start: createWaveRequest.voting.period?.min ?? null,
      voting_period_end: createWaveRequest.voting.period?.max ?? null,
      visibility_group_id: createWaveRequest.visibility.scope.group_id,
      participation_group_id: createWaveRequest.participation.scope.group_id,
      chat_group_id: createWaveRequest.chat.scope.group_id,
      participation_max_applications_per_participant:
        createWaveRequest.participation
          .no_of_applications_allowed_per_participant,
      participation_required_metadata:
        createWaveRequest.participation.required_metadata.map((md) => ({
          name: md.name,
          type: resolveEnumOrThrow(
            WaveRequiredMetadataItemType,
            md.type.toString()
          )
        })),
      participation_required_media:
        createWaveRequest.participation.required_media.map((it) =>
          resolveEnumOrThrow(ParticipationRequiredMedia, it)
        ),
      participation_period_start:
        createWaveRequest.participation.period?.min ?? null,
      participation_period_end:
        createWaveRequest.participation.period?.max ?? null,
      type: resolveEnumOrThrow(WaveType, createWaveRequest.wave.type),
      winning_min_threshold:
        createWaveRequest.wave.winning_thresholds?.min ?? null,
      winning_max_threshold:
        createWaveRequest.wave.winning_thresholds?.max ?? null,
      max_winners: createWaveRequest.wave.max_winners ?? null,
      time_lock_ms: createWaveRequest.wave.time_lock_ms ?? null,
      wave_period_start: createWaveRequest.wave.period?.min ?? null,
      wave_period_end: createWaveRequest.wave.period?.max ?? null,
      outcomes: JSON.stringify(createWaveRequest.outcomes)
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
      authenticatedUserMetrics
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
        authenticatedUserMetrics
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
    authenticatedUserMetrics
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
      credit_type: resolveEnumOrThrow(
        WaveCreditTypeApi,
        waveEntity.voting_credit_type
      ),
      credit_scope: resolveEnumOrThrow(
        WaveCreditScopeApi,
        waveEntity.voting_credit_scope_type
      ),
      credit_category: waveEntity.voting_credit_category,
      creditor: voteCreditor,
      signature_required: waveEntity.voting_signature_required,
      period: {
        min: waveEntity.voting_period_start,
        max: waveEntity.voting_period_end
      },
      authenticated_user_eligible: authenticatedUserEligibleToVote
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
          type: resolveEnumOrThrow(ApiWaveMetadataType, it.type)
        })
      ),
      required_media: waveEntity.participation_required_media.map((it) =>
        resolveEnumOrThrow(ApiWaveParticipationRequirement, it)
      ),
      signature_required: waveEntity.voting_signature_required,
      period: {
        min: waveEntity.participation_period_start,
        max: waveEntity.participation_period_end
      },
      authenticated_user_eligible: authenticatedUserEligibleToParticipate
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
      type: resolveEnumOrThrow(WaveTypeApi, waveEntity.type),
      winning_thresholds: {
        min: waveEntity.winning_min_threshold,
        max: waveEntity.winning_max_threshold
      },
      max_winners: waveEntity.max_winners,
      time_lock_ms: waveEntity.time_lock_ms,
      period: {
        min: waveEntity.wave_period_start,
        max: waveEntity.wave_period_end
      },
      admin_group: {
        group: curations[waveEntity.admin_group_id!] ?? null
      },
      authenticated_user_eligible_for_admin: authenticatedUserEligibleForAdmin
    };
    const waveMetrics = metrics[waveEntity.id];
    const waveAuthenticatedUserMetrics =
      authenticatedUserMetrics[waveEntity.id];

    const apiWaveMetrics: ApiWaveMetrics = {
      drops_count: waveMetrics.drops_count,
      subscribers_count: waveMetrics.subscribers_count,
      latest_drop_timestamp: waveMetrics.latest_drop_timestamp,
      your_drops_count: waveAuthenticatedUserMetrics?.drops_count,
      your_latest_drop_timestamp:
        waveAuthenticatedUserMetrics?.latest_drop_timestamp
    };
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
      outcomes: JSON.parse(waveEntity.outcomes),
      subscribed_actions: subscribedActions[waveEntity.id] ?? [],
      metrics: apiWaveMetrics
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
      contributorsOverViews,
      creationDropsByDropId,
      subscribedActions
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
      this.wavesApiDb.getWavesContributorsOverviews(waveIds, ctx),

      dropsService
        .findDropsByIdsOrThrow(
          distinct(waveEntities.map((it) => it.description_drop_id)),
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
        : Promise.resolve({} as Record<string, ActivityEventAction[]>)
    ]);
    const profileIds = distinct([
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
    const profileMins: Record<string, ApiProfileMin> =
      await this.profilesApiService.getProfileMinsByIds(
        {
          ids: profileIds,
          authenticatedProfileId: ctx.authenticationContext?.getActingAsId(),
          timer: ctx.timer
        },
        ctx.connection
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
            is_hidden: false
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
            resolveEnumOrThrow(ApiWaveSubscriptionTargetAction, it)
          );
          return acc;
        },
        {} as Record<string, ApiWaveSubscriptionTargetAction[]>
      ),
      metrics,
      authenticatedUserMetrics
    };
  }
}

export const wavesMappers = new WavesMappers(
  profilesApiService,
  userGroupsService,
  wavesApiDb,
  identitySubscriptionsDb
);
