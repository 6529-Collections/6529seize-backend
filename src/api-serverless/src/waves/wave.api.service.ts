import { SearchWavesParams, wavesApiDb, WavesApiDb } from './waves.api.db';
import { CreateNewWave } from '../generated/models/CreateNewWave';
import { Wave } from '../generated/models/Wave';
import {
  assertUnreachable,
  distinct,
  resolveEnumOrThrow
} from '../../../helpers';
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
import {
  activityRecorder,
  ActivityRecorder
} from '../../../activity/activity.recorder';
import { WaveSubscriptionTargetAction } from '../generated/models/WaveSubscriptionTargetAction';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import {
  profilesApiService,
  ProfilesApiService
} from '../profiles/profiles.api.service';
import { WavesOverviewType } from '../generated/models/WavesOverviewType';
import { WaveEntity } from '../../../entities/IWave';
import { RequestContext } from '../../../request.context';

export class WaveApiService {
  constructor(
    private readonly wavesApiDb: WavesApiDb,
    private readonly profilesService: ProfilesApiService,
    private readonly userGroupsService: UserGroupsService,
    private readonly waveMappers: WavesMappers,
    private readonly activityRecorder: ActivityRecorder,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb
  ) {}

  public async createWave(
    createWaveRequest: CreateNewWave,
    ctx: RequestContext
  ): Promise<Wave> {
    const timer = ctx.timer!;
    const authenticationContext = ctx.authenticationContext!;
    timer.start('waveApiService->createWave');
    await this.validateWaveRelations(createWaveRequest, ctx);
    const createdWave = await this.wavesApiDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctxWithConnection = { ...ctx, connection };
        const id = randomUUID();
        const descriptionDropId = await dropCreationService
          .createWaveDrop(
            id,
            createWaveRequest.description_drop,
            ctxWithConnection
          )
          .then((drop) => drop.id);
        const newEntity = this.waveMappers.createWaveToNewWaveEntity(
          createWaveRequest,
          descriptionDropId,
          ctx
        );
        await this.wavesApiDb.insertWave(id, newEntity, ctxWithConnection);
        await this.identitySubscriptionsDb.addIdentitySubscription(
          {
            subscriber_id: newEntity.created_by,
            target_id: id,
            target_type: ActivityEventTargetType.WAVE,
            target_action: ActivityEventAction.DROP_CREATED
          },
          connection,
          timer
        );
        timer.start(`waveApiService->findWaveById`);
        const waveEntity = await this.wavesApiDb.findWaveById(id, connection);
        timer.stop(`waveApiService->findWaveById`);

        if (!waveEntity) {
          throw new Error(`Something went wrong while creating wave ${id}`);
        }
        await this.activityRecorder.recordWaveCreated(
          {
            creator_id: waveEntity.created_by,
            wave_id: id,
            visibility_group_id: waveEntity.visibility_group_id
          },
          ctxWithConnection
        );
        const groupIdsUserIsEligibleFor =
          await this.userGroupsService.getGroupsUserIsEligibleFor(
            authenticationContext.getActingAsId(),
            timer
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
          ctxWithConnection
        );
      }
    );
    await giveReadReplicaTimeToCatchUp();
    timer.stop('waveApiService->createWave');
    return createdWave;
  }

  private async validateWaveRelations(
    createWave: CreateNewWave,
    ctx: RequestContext
  ) {
    const authenticatedProfileId = ctx.authenticationContext!.getActingAsId()!;
    const timer = ctx.timer;
    timer?.start(`waveApiService->validateWaveRelations`);
    this.validateOutcomes(createWave);
    const referencedGroupIds = distinct(
      [
        createWave.visibility.scope.group_id,
        createWave.participation.scope.group_id,
        createWave.voting.scope.group_id
      ].filter((id) => id !== null) as string[]
    );
    timer?.start(`waveApiService->userGroupsService->getByIds`);
    const groupEntities = await this.userGroupsService.getByIds(
      referencedGroupIds,
      ctx
    );
    timer?.stop(`waveApiService->userGroupsService->getByIds`);
    const missingGroupIds = referencedGroupIds.filter(
      (it) => !groupEntities.find((e) => e.id === it)
    );
    if (missingGroupIds.length) {
      timer?.stop(`waveApiService->validateWaveRelations`);
      throw new BadRequestException(
        `Group(s) not found: ${missingGroupIds.join(', ')}`
      );
    }
    const referencedCreditorId = createWave.voting.creditor_id;
    if (referencedCreditorId) {
      const creditorProfile = (
        await this.profilesService.getProfileMinsByIds({
          ids: [referencedCreditorId],
          authenticatedProfileId,
          timer
        })
      )[referencedCreditorId];
      timer?.stop(`waveApiService->validateWaveRelations`);
      if (!creditorProfile) {
        throw new BadRequestException(
          `Creditor not found: ${referencedCreditorId}`
        );
      }
    } else {
      timer?.stop(`waveApiService->validateWaveRelations`);
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
    ctx: RequestContext
  ): Promise<Wave[]> {
    const authenticationContext = ctx.authenticationContext;
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
      ctx
    );
  }

  async findWavesByIdsOrThrow(
    ids: string[],
    groupIdsUserIsEligibleFor: string[],
    authenticationContext?: AuthenticationContext
  ): Promise<Record<string, Wave>> {
    const entities = await this.wavesApiDb.findWavesByIds(
      ids,
      groupIdsUserIsEligibleFor
    );
    const missingWaves = ids.filter((it) => !entities.find((e) => e.id === it));
    if (missingWaves.length) {
      throw new NotFoundException(
        `Wave(s) not found: ${missingWaves.join(', ')}`
      );
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
    return await this.waveMappers
      .waveEntitiesToApiWaves(
        {
          waveEntities: entities,
          groupIdsUserIsEligibleFor,
          noRightToVote,
          noRightToParticipate
        },
        { authenticationContext }
      )
      .then((res) =>
        res.reduce((acc, it) => {
          acc[it.id] = it;
          return acc;
        }, {} as Record<string, Wave>)
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
      { authenticationContext }
    );
  }

  async addWaveSubscriptionActions({
    subscriber,
    waveId,
    actions
  }: {
    subscriber: string;
    waveId: string;
    actions: WaveSubscriptionTargetAction[];
  }): Promise<WaveSubscriptionTargetAction[]> {
    const groupsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(subscriber);
    await this.findWaveByIdOrThrow(waveId, groupsUserIsEligibleFor);
    const proposedActions = Object.values(actions).map((it) =>
      resolveEnumOrThrow(ActivityEventAction, it)
    );
    return await this.identitySubscriptionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const existingActions =
          await this.identitySubscriptionsDb.findIdentitySubscriptionActionsOfTarget(
            {
              subscriber_id: subscriber,
              target_id: waveId,
              target_type: ActivityEventTargetType.WAVE
            },
            connection
          );
        const actionsToAdd = proposedActions.filter(
          (it) => !existingActions.includes(it)
        );
        for (const action of actionsToAdd) {
          await this.identitySubscriptionsDb.addIdentitySubscription(
            {
              subscriber_id: subscriber,
              target_id: waveId,
              target_type: ActivityEventTargetType.WAVE,
              target_action: action
            },
            connection
          );
        }
        return await this.identitySubscriptionsDb
          .findIdentitySubscriptionActionsOfTarget(
            {
              subscriber_id: subscriber,
              target_id: waveId,
              target_type: ActivityEventTargetType.WAVE
            },
            connection
          )
          .then((result) =>
            result.map((it) =>
              resolveEnumOrThrow(WaveSubscriptionTargetAction, it)
            )
          );
      }
    );
  }

  async removeWaveSubscriptionActions({
    subscriber,
    waveId,
    actions
  }: {
    subscriber: string;
    waveId: string;
    actions: WaveSubscriptionTargetAction[];
  }): Promise<WaveSubscriptionTargetAction[]> {
    const groupsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(subscriber);
    await this.findWaveByIdOrThrow(waveId, groupsUserIsEligibleFor);
    return this.identitySubscriptionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        for (const action of actions) {
          await this.identitySubscriptionsDb.deleteIdentitySubscription(
            {
              subscriber_id: subscriber,
              target_id: waveId,
              target_type: ActivityEventTargetType.WAVE,
              target_action: resolveEnumOrThrow(ActivityEventAction, action)
            },
            connection
          );
        }
        return await this.identitySubscriptionsDb
          .findIdentitySubscriptionActionsOfTarget(
            {
              subscriber_id: subscriber,
              target_id: waveId,
              target_type: ActivityEventTargetType.WAVE
            },
            connection
          )
          .then((result) =>
            result.map((it) =>
              resolveEnumOrThrow(WaveSubscriptionTargetAction, it)
            )
          );
      }
    );
  }

  public async getWavesOverview(
    { type, limit, offset }: WavesOverviewParams,
    authenticationContext?: AuthenticationContext
  ) {
    const authenticatedProfileId = authenticationContext?.getActingAsId();
    if (!authenticatedProfileId) {
      if (type === WavesOverviewType.AuthorYouHaveRepped) {
        throw new BadRequestException(
          `You can't see waves you have repped without having a profile or being authenticated`
        );
      }
    }
    const eligibleGroups =
      !authenticationContext ||
      !authenticatedProfileId ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ApiProfileProxyActionType.READ_WAVE
        ])
        ? []
        : await this.userGroupsService.getGroupsUserIsEligibleFor(
            authenticatedProfileId
          );
    const entities = await this.findWaveEntitiesByType({
      type,
      limit,
      authenticatedUserId: authenticatedProfileId ?? null,
      eligibleGroups,
      offset
    });
    const noRightToVote =
      !authenticationContext ||
      !authenticatedProfileId ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ApiProfileProxyActionType.RATE_WAVE_DROP
        ]);
    const noRightToParticipate =
      !authenticationContext ||
      !authenticatedProfileId ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ApiProfileProxyActionType.CREATE_DROP_TO_WAVE
        ]);
    return this.waveMappers.waveEntitiesToApiWaves(
      {
        waveEntities: entities,
        groupIdsUserIsEligibleFor: eligibleGroups,
        noRightToVote,
        noRightToParticipate
      },
      { authenticationContext }
    );
  }

  private async findWaveEntitiesByType({
    eligibleGroups,
    type,
    authenticatedUserId,
    limit,
    offset
  }: {
    eligibleGroups: string[];
    type: WavesOverviewType;
    limit: number;
    offset: number;
    authenticatedUserId: string | null;
  }): Promise<WaveEntity[]> {
    switch (type) {
      case WavesOverviewType.Latest:
        return await this.wavesApiDb.findLatestWaves(
          eligibleGroups,
          limit,
          offset
        );
      case WavesOverviewType.MostSubscribed:
        return await this.wavesApiDb.findMostSubscribedWaves(
          eligibleGroups,
          limit,
          offset
        );
      case WavesOverviewType.HighLevelAuthor:
        return await this.wavesApiDb.findHighLevelAuthorWaves(
          eligibleGroups,
          limit,
          offset
        );
      case WavesOverviewType.AuthorYouHaveRepped:
        return await this.wavesApiDb.findWavesByAuthorsYouHaveRepped(
          eligibleGroups,
          authenticatedUserId!,
          limit,
          offset
        );
      default:
        assertUnreachable(type);
    }
    return []; // unreachable code but typescript doesn't know that
  }
}

export interface WavesOverviewParams {
  limit: number;
  offset: number;
  type: WavesOverviewType;
}

export const waveApiService = new WaveApiService(
  wavesApiDb,
  profilesApiService,
  userGroupsService,
  wavesMappers,
  activityRecorder,
  identitySubscriptionsDb
);
