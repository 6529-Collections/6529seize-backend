import { CreateNewWave } from '../generated/models/CreateNewWave';
import { NewWaveEntity, wavesApiDb, WavesApiDb } from './waves.api.db';
import { distinct, resolveEnumOrThrow } from '../../../helpers';
import {
  ParticipationRequiredMedia,
  WaveCreditScopeType,
  WaveCreditType,
  WaveEntity,
  WaveType
} from '../../../entities/IWave';
import { Wave } from '../generated/models/Wave';
import { ProfileMin } from '../generated/models/ProfileMin';
import { WaveCreditType as WaveCreditTypeApi } from '../generated/models/WaveCreditType';
import { WaveCreditScope as WaveCreditScopeApi } from '../generated/models/WaveCreditScope';
import { WaveType as WaveTypeApi } from '../generated/models/WaveType';
import {
  profilesService,
  ProfilesService
} from '../../../profiles/profiles.service';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { Group } from '../generated/models/Group';
import { dropsService } from '../drops/drops.api.service';
import { ConnectionWrapper } from '../../../sql-executor';
import { WaveParticipationRequirement } from '../generated/models/WaveParticipationRequirement';
import { Drop } from '../generated/models/Drop';
import { WaveVotingConfig } from '../generated/models/WaveVotingConfig';
import { WaveScope } from '../generated/models/WaveScope';
import { WaveContributorOverview } from '../generated/models/WaveContributorOverview';
import { WaveVisibilityConfig } from '../generated/models/WaveVisibilityConfig';
import { WaveParticipationConfig } from '../generated/models/WaveParticipationConfig';
import { WaveConfig } from '../generated/models/WaveConfig';
import { AuthenticationContext } from '../../../auth-context';

export class WavesMappers {
  constructor(
    private readonly profilesService: ProfilesService,
    private readonly userGroupsService: UserGroupsService,
    private readonly wavesApiDb: WavesApiDb
  ) {}

  public createWaveToNewWaveEntity(
    createWaveRequest: CreateNewWave,
    authorId: string,
    descriptionDropId: string
  ): NewWaveEntity {
    return {
      name: createWaveRequest.name,
      description_drop_id: descriptionDropId,
      picture: createWaveRequest.picture,
      created_by: authorId,
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
      participation_max_applications_per_participant:
        createWaveRequest.participation
          .no_of_applications_allowed_per_participant,
      participation_required_metadata: JSON.stringify(
        createWaveRequest.participation.required_metadata
      ),
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
    authenticationContext: AuthenticationContext | undefined,
    connection?: ConnectionWrapper<any>
  ): Promise<Wave> {
    return this.waveEntitiesToApiWaves(
      {
        waveEntities: [waveEntity],
        groupIdsUserIsEligibleFor,
        noRightToVote,
        noRightToParticipate
      },
      authenticationContext,
      connection
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
    authenticationContext: AuthenticationContext | undefined,
    connection?: ConnectionWrapper<any>
  ): Promise<Wave[]> {
    const { contributors, profiles, curations, creationDrops } =
      await this.getRelatedData(
        waveEntities,
        authenticationContext,
        connection
      );
    return waveEntities.map<Wave>((waveEntity) =>
      this.mapWaveEntityToApiWave({
        waveEntity,
        profiles,
        contributors,
        creationDrops,
        curations,
        noRightToVote,
        groupIdsUserIsEligibleFor,
        noRightToParticipate
      })
    );
  }

  private mapWaveEntityToApiWave({
    waveEntity,
    profiles,
    contributors,
    creationDrops,
    curations,
    noRightToVote,
    groupIdsUserIsEligibleFor,
    noRightToParticipate
  }: {
    waveEntity: WaveEntity;
    profiles: Record<string, ProfileMin>;
    contributors: Record<
      string,
      {
        contributor_identity: string;
        contributor_pfp: string;
      }[]
    >;
    creationDrops: Record<string, Drop>;
    curations: Record<string, Group>;
    noRightToVote: boolean;
    groupIdsUserIsEligibleFor: string[];
    noRightToParticipate: boolean;
  }) {
    const contributorsOverview: WaveContributorOverview[] =
      contributors[waveEntity.id]?.map((it) => ({
        contributor_identity: it.contributor_identity,
        contributor_pfp: it.contributor_pfp
      })) ?? [];
    const creationDrop: Drop = creationDrops[waveEntity.description_drop_id];
    const votingScope: WaveScope = {
      group: curations[waveEntity.voting_group_id!] ?? null
    };
    const voteCreditor: ProfileMin | null =
      profiles[waveEntity.voting_credit_creditor!] ?? null;
    const authenticatedUserEligibleToVote =
      !noRightToVote &&
      (!waveEntity.voting_group_id ||
        groupIdsUserIsEligibleFor.includes(waveEntity.voting_group_id));
    const voting: WaveVotingConfig = {
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
    const visibility: WaveVisibilityConfig = {
      scope: {
        group: curations[waveEntity.visibility_group_id!] ?? null
      }
    };
    const authenticatedUserEligibleToParticipate =
      !noRightToParticipate &&
      (!waveEntity.participation_group_id ||
        groupIdsUserIsEligibleFor.includes(waveEntity.participation_group_id));
    const participation: WaveParticipationConfig = {
      scope: {
        group: curations[waveEntity.participation_group_id!] ?? null
      },
      no_of_applications_allowed_per_participant:
        waveEntity.participation_max_applications_per_participant,
      required_metadata: JSON.parse(waveEntity.participation_required_metadata),
      required_media: waveEntity.participation_required_media.map((it) =>
        resolveEnumOrThrow(WaveParticipationRequirement, it)
      ),
      signature_required: waveEntity.voting_signature_required,
      period: {
        min: waveEntity.participation_period_start,
        max: waveEntity.participation_period_end
      },
      authenticated_user_eligible: authenticatedUserEligibleToParticipate
    };
    const authenticatedUserEligibleForAdmin = !!(
      waveEntity.admin_group_id &&
      groupIdsUserIsEligibleFor.includes(waveEntity.admin_group_id)
    );
    const waveConf: WaveConfig = {
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
      wave: waveConf,
      outcomes: JSON.parse(waveEntity.outcomes)
    };
  }

  private async getRelatedData(
    waveEntities: WaveEntity[],
    authenticationContext: AuthenticationContext | undefined,
    connection?: ConnectionWrapper<any>
  ): Promise<{
    contributors: Record<
      string,
      { contributor_identity: string; contributor_pfp: string }[]
    >;
    profiles: Record<string, ProfileMin>;
    curations: Record<string, Group>;
    creationDrops: Record<string, Drop>;
  }> {
    const curationEntities = await this.userGroupsService.getByIds(
      waveEntities
        .map(
          (waveEntity) =>
            [
              waveEntity.visibility_group_id,
              waveEntity.participation_group_id,
              waveEntity.voting_group_id,
              waveEntity.admin_group_id
            ].filter((id) => id !== null) as string[]
        )
        .flat(),
      connection
    );
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
    const contributorsOverViews =
      await this.wavesApiDb.getWavesContributorsOverviews(
        waveEntities.map((it) => it.id),
        connection
      );
    const profileMins: Record<string, ProfileMin> = await this.profilesService
      .getProfileMinsByIds(profileIds, connection)
      .then((profileMins) =>
        profileMins.reduce((acc, profileMin) => {
          acc[profileMin.id] = {
            ...profileMin
          };
          return acc;
        }, {} as Record<string, ProfileMin>)
      );
    const curations: Record<string, Group> = curationEntities.reduce(
      (acc, curationEntity) => {
        acc[curationEntity.id] = {
          id: curationEntity.id,
          name: curationEntity.name,
          author: profileMins[curationEntity.created_by],
          created_at: new Date(curationEntity.created_at).getTime()
        };
        return acc;
      },
      {} as Record<string, Group>
    );
    const creationDropsByDropId = await dropsService.findDropsByIdsOrThrow(
      distinct(waveEntities.map((it) => it.description_drop_id)),
      authenticationContext,
      connection
    );
    return {
      contributors: contributorsOverViews,
      profiles: profileMins,
      curations,
      creationDrops: creationDropsByDropId
    };
  }
}

export const wavesMappers = new WavesMappers(
  profilesService,
  userGroupsService,
  wavesApiDb
);
