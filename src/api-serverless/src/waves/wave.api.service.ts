import { SearchWavesParams, wavesApiDb, WavesApiDb } from './waves.api.db';
import { CreateNewWave } from '../generated/models/CreateNewWave';
import { Wave } from '../generated/models/Wave';
import { assertUnreachable, distinct } from '../../../helpers';
import {
  profilesService,
  ProfilesService
} from '../../../profiles/profiles.service';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import { wavesMappers, WavesMappers } from './waves.mappers';
import { randomUUID } from 'crypto';
import { dropCreationService } from '../drops/drop-creation.api.service';
import { AuthenticationContext } from '../../../auth-context';
import { WaveType } from '../generated/models/WaveType';
import { WaveOutcomeType } from '../generated/models/WaveOutcomeType';
import { WaveOutcomeSubType } from '../generated/models/WaveOutcomeSubType';
import { ApiProfileProxyActionType } from '../../../entities/IProfileProxyAction';

export class WaveApiService {
  constructor(
    private readonly wavesApiDb: WavesApiDb,
    private readonly profilesService: ProfilesService,
    private readonly userGroupsService: UserGroupsService,
    private readonly waveMappers: WavesMappers
  ) {}

  public async createWave({
    createWaveRequest,
    authenticationContext
  }: {
    createWaveRequest: CreateNewWave;
    authenticationContext: AuthenticationContext;
  }): Promise<Wave> {
    await this.validateWaveRelations(createWaveRequest);
    const createdWave = await this.wavesApiDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const id = randomUUID();
        const descriptionDropId = await dropCreationService
          .createWaveDrop(
            id,
            createWaveRequest.description_drop,
            authenticationContext,
            connection
          )
          .then((drop) => drop.id);
        const newEntity = this.waveMappers.createWaveToNewWaveEntity(
          createWaveRequest,
          authenticationContext.getActingAsId()!,
          descriptionDropId
        );
        await this.wavesApiDb.insertWave(id, newEntity, connection);

        const waveEntity = await this.wavesApiDb.findWaveById(id, connection);

        if (!waveEntity) {
          throw new Error(`Something went wrong while creating wave ${id}`);
        }
        const groupIdsUserIsEligibleFor =
          await this.userGroupsService.getGroupsUserIsEligibleFor(
            authenticationContext.getActingAsId()
          );
        const noRightToVote =
          authenticationContext.isAuthenticatedAsProxy() &&
          !authenticationContext.activeProxyActions[
            ApiProfileProxyActionType.RATE_WAVE_DROP
          ];
        const noRightToParticipate =
          authenticationContext.isAuthenticatedAsProxy() &&
          !authenticationContext.activeProxyActions[
            ApiProfileProxyActionType.CREATE_DROP_TO_WAVE
          ];
        return await this.waveMappers.waveEntityToApiWave(
          {
            waveEntity,
            groupIdsUserIsEligibleFor,
            noRightToVote,
            noRightToParticipate
          },
          authenticationContext,
          connection
        );
      }
    );
    await giveReadReplicaTimeToCatchUp();
    return createdWave;
  }

  private async validateWaveRelations(createWave: CreateNewWave) {
    this.validateOutcomes(createWave);
    const referencedGroupIds = distinct(
      [
        createWave.visibility.scope.group_id,
        createWave.participation.scope.group_id,
        createWave.voting.scope.group_id
      ].filter((id) => id !== null) as string[]
    );
    const groupEntities = await this.userGroupsService.getByIds(
      referencedGroupIds
    );
    const missingGroupIds = referencedGroupIds.filter(
      (it) => !groupEntities.find((e) => e.id === it)
    );
    if (missingGroupIds.length) {
      throw new BadRequestException(
        `Group(s) not found: ${missingGroupIds.join(', ')}`
      );
    }
    const referencedCreditorId = createWave.voting.creditor_id;
    if (referencedCreditorId) {
      const creditorProfile = await this.profilesService.getProfileMinsByIds([
        referencedCreditorId
      ]);
      if (!creditorProfile.length) {
        throw new BadRequestException(
          `Creditor not found: ${referencedCreditorId}`
        );
      }
    }
  }

  private validateOutcomes(createWave: CreateNewWave) {
    const waveType = createWave.wave.type;
    switch (waveType) {
      case WaveType.Approve: {
        if (createWave.outcomes.find((it) => it.distribution?.length)) {
          throw new BadRequestException(
            `Waves of type ${WaveType.Approve} can't have distribution in outcomes`
          );
        }
        break;
      }
      case WaveType.Rank: {
        const creditDistributionOutcomes = createWave.outcomes.filter(
          (it) =>
            it.type == WaveOutcomeType.Automatic &&
            it.subtype === WaveOutcomeSubType.CreditDistribution
        );
        if (
          creditDistributionOutcomes.length &&
          !creditDistributionOutcomes.find((it) => it.distribution?.length)
        ) {
          throw new BadRequestException(
            `Credit distribution outcomes for waves of type ${WaveType.Rank} need to have distribution described`
          );
        }
        const non100PercentDistributions = creditDistributionOutcomes.filter(
          (outcome) =>
            outcome.distribution?.reduce((acc, it) => acc + it, 0) !== 100
        );
        if (non100PercentDistributions.length) {
          throw new BadRequestException(
            `There are ${non100PercentDistributions.length} credit distribution outcomes where the distribution does not add up to 100%`
          );
        }
        break;
      }
      case WaveType.Chat: {
        if (createWave.outcomes.length) {
          throw new BadRequestException(
            `Waves of type ${WaveType.Chat} can't have outcomes`
          );
        }
        break;
      }
      default: {
        assertUnreachable(waveType);
      }
    }
  }

  async searchWaves(
    params: SearchWavesParams,
    authenticationContext?: AuthenticationContext
  ): Promise<Wave[]> {
    let groupsUserIsEligibleFor: string[];
    if (!authenticationContext) {
      groupsUserIsEligibleFor = [];
    } else {
      const authenticatedProfileId = authenticationContext.getActingAsId();
      if (
        authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ApiProfileProxyActionType.READ_WAVE
        ]
      ) {
        groupsUserIsEligibleFor = [];
      } else {
        groupsUserIsEligibleFor =
          await this.userGroupsService.getGroupsUserIsEligibleFor(
            authenticatedProfileId
          );
      }
    }
    const entities = await this.wavesApiDb.searchWaves(
      params,
      groupsUserIsEligibleFor
    );
    const noRightToVote =
      !authenticationContext ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ApiProfileProxyActionType.RATE_WAVE_DROP
        ]);
    const noRightToParticipate =
      !authenticationContext ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ApiProfileProxyActionType.CREATE_DROP_TO_WAVE
        ]);
    return await this.waveMappers.waveEntitiesToApiWaves(
      {
        waveEntities: entities,
        groupIdsUserIsEligibleFor: groupsUserIsEligibleFor,
        noRightToVote,
        noRightToParticipate
      },
      authenticationContext
    );
  }

  async findWaveByIdOrThrow(
    id: string,
    groupIdsUserIsEligibleFor: string[],
    authenticationContext?: AuthenticationContext
  ): Promise<Wave> {
    const entity = await this.wavesApiDb.findWaveById(id);
    if (!entity) {
      throw new NotFoundException(`Wave ${id} not found`);
    }
    const noRightToVote =
      !authenticationContext ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ApiProfileProxyActionType.RATE_WAVE_DROP
        ]);
    const noRightToParticipate =
      !authenticationContext ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ApiProfileProxyActionType.CREATE_DROP_TO_WAVE
        ]);
    return await this.waveMappers.waveEntityToApiWave(
      {
        waveEntity: entity,
        groupIdsUserIsEligibleFor,
        noRightToVote,
        noRightToParticipate
      },
      authenticationContext
    );
  }
}

export const waveApiService = new WaveApiService(
  wavesApiDb,
  profilesService,
  userGroupsService,
  wavesMappers
);
