import { SearchWavesParams, wavesApiDb, WavesApiDb } from './waves.api.db';
import { ApiCreateNewWave } from '../generated/models/ApiCreateNewWave';
import { ApiWave } from '../generated/models/ApiWave';
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
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../../../exceptions';
import { wavesMappers, WavesMappers } from './waves.mappers';
import { randomUUID } from 'crypto';
import { AuthenticationContext } from '../../../auth-context';
import { ProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import {
  activityRecorder,
  ActivityRecorder
} from '../../../activity/activity.recorder';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import { WaveEntity } from '../../../entities/IWave';
import { RequestContext } from '../../../request.context';
import { ApiUpdateWaveRequest } from '../generated/models/ApiUpdateWaveRequest';
import { Time } from '../../../time';
import {
  createOrUpdateDrop,
  CreateOrUpdateDropUseCase
} from '../../../drops/create-or-update-drop.use-case';
import { dropsMappers, DropsMappers } from '../drops/drops.mappers';
import { ApiDropType } from '../generated/models/ApiDropType';
import { ApiWaveType } from '../generated/models/ApiWaveType';
import { ApiWaveOutcomeType } from '../generated/models/ApiWaveOutcomeType';
import { ApiWaveOutcomeSubType } from '../generated/models/ApiWaveOutcomeSubType';
import { ApiWaveSubscriptionTargetAction } from '../generated/models/ApiWaveSubscriptionTargetAction';
import { ApiWavesOverviewType } from '../generated/models/ApiWavesOverviewType';
import {
  dropVotingService,
  DropVotingService
} from '../drops/drop-voting.service';
import { clappingService, ClappingService } from '../drops/clapping.service';
import { profilesService } from '../../../profiles/profiles.service';

export class WaveApiService {
  constructor(
    private readonly wavesApiDb: WavesApiDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly waveMappers: WavesMappers,
    private readonly activityRecorder: ActivityRecorder,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly createOrUpdateDrop: CreateOrUpdateDropUseCase,
    private readonly dropsMappers: DropsMappers,
    private readonly dropVotingService: DropVotingService,
    private readonly clappingService: ClappingService
  ) {}

  public async createWave(
    createWaveRequest: ApiCreateNewWave,
    ctx: RequestContext
  ): Promise<ApiWave> {
    const timer = ctx.timer!;
    const authenticationContext = ctx.authenticationContext!;
    timer.start(`${this.constructor.name}->createWave`);
    await this.validateWaveRelations(createWaveRequest, ctx);
    const createdWave = await this.wavesApiDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctxWithConnection = { ...ctx, connection };
        const id = randomUUID();
        const newEntity = await this.waveMappers.createWaveToNewWaveEntity(
          id,
          null,
          Time.currentMillis(),
          null,
          createWaveRequest,
          authenticationContext.getActingAsId()!,
          randomUUID()
        );
        await this.wavesApiDb.insertWave(newEntity, ctxWithConnection);
        const authorId = authenticationContext.getActingAsId()!;
        const descriptionDropModel =
          this.dropsMappers.createDropApiToUseCaseModel({
            request: {
              ...createWaveRequest.description_drop,
              wave_id: id,
              drop_type: ApiDropType.Chat
            },
            authorId
          });
        const descriptionDropId = await this.createOrUpdateDrop
          .execute(descriptionDropModel, true, {
            timer: ctxWithConnection.timer!,
            connection: ctxWithConnection.connection
          })
          .then((resp) => resp.drop_id);
        await this.wavesApiDb.updateDescriptionDropId(
          {
            waveId: id,
            newDescriptionDropId: descriptionDropId
          },
          connection
        );
        await this.identitySubscriptionsDb.addIdentitySubscription(
          {
            subscriber_id: newEntity.created_by,
            target_id: id,
            target_type: ActivityEventTargetType.WAVE,
            target_action: ActivityEventAction.DROP_CREATED,
            wave_id: id,
            subscribed_to_all_drops: false
          },
          connection,
          timer
        );
        timer.start(`${this.constructor.name}->findWaveById`);
        const waveEntity = await this.wavesApiDb.findWaveById(id, connection);
        timer.stop(`${this.constructor.name}->findWaveById`);

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
            ProfileProxyActionType.RATE_WAVE_DROP
          ];
        const noRightToParticipate =
          authenticationContext.isAuthenticatedAsProxy() &&
          !authenticationContext.activeProxyActions[
            ProfileProxyActionType.CREATE_DROP_TO_WAVE
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
    timer.stop(`${this.constructor.name}->createWave`);
    return createdWave;
  }

  private async validateWaveRelations(
    createWave: ApiCreateNewWave | ApiUpdateWaveRequest,
    ctx: RequestContext
  ) {
    const timer = ctx.timer;
    timer?.start(`${this.constructor.name}->validateWaveRelations`);
    if (createWave.wave.type === ApiWaveType.Chat && !createWave.chat.enabled) {
      throw new BadRequestException(`Chat waves need to have chat enabled`);
    }
    if (
      createWave.wave.time_lock_ms !== null &&
      createWave.wave.time_lock_ms > 0
    ) {
      throw new BadRequestException(
        `Creating a wave with time locked voting is not yet supported`
      );
    }
    if (createWave.voting.signature_required) {
      throw new BadRequestException(
        `Creating a wave with signed votes requirement is not yet supported`
      );
    }
    if (createWave.participation.signature_required) {
      throw new BadRequestException(
        `Creating a wave with signed drops requirement is not yet supported`
      );
    }
    this.validateOutcomes(createWave);
    const referencedGroupIds = distinct(
      [
        createWave.visibility.scope.group_id,
        createWave.participation.scope.group_id,
        createWave.voting.scope.group_id
      ].filter((id) => id !== null) as string[]
    );
    timer?.start(`${this.constructor.name}->userGroupsService->getByIds`);
    const groupEntities = await this.userGroupsService.getByIds(
      referencedGroupIds,
      ctx
    );
    timer?.stop(`${this.constructor.name}->userGroupsService->getByIds`);
    const missingGroupIds = referencedGroupIds.filter(
      (it) => !groupEntities.find((e) => e.id === it)
    );
    if (missingGroupIds.length) {
      timer?.stop(`${this.constructor.name}->validateWaveRelations`);
      throw new BadRequestException(
        `Group(s) not found: ${missingGroupIds.join(', ')}`
      );
    }
    const referencedCreditorIdentity = createWave.voting.creditor_id;
    if (referencedCreditorIdentity) {
      await profilesService.resolveIdentityIdOrThrowNotFound(
        referencedCreditorIdentity
      );
    }
    timer?.stop(`${this.constructor.name}->validateWaveRelations`);
  }

  private validateOutcomes(
    createWave: ApiCreateNewWave | ApiUpdateWaveRequest
  ) {
    const waveType = createWave.wave.type;
    switch (waveType) {
      case ApiWaveType.Approve: {
        if (createWave.outcomes.find((it) => it.distribution?.length)) {
          throw new BadRequestException(
            `Waves of type ${ApiWaveType.Approve} can't have distribution in outcomes`
          );
        }
        break;
      }
      case ApiWaveType.Rank: {
        const creditDistributionOutcomes = createWave.outcomes.filter(
          (it) =>
            it.type == ApiWaveOutcomeType.Automatic &&
            it.subtype === ApiWaveOutcomeSubType.CreditDistribution
        );
        if (
          creditDistributionOutcomes.length &&
          !creditDistributionOutcomes.find((it) => it.distribution?.length)
        ) {
          throw new BadRequestException(
            `Credit distribution outcomes for waves of type ${ApiWaveType.Rank} need to have distribution described`
          );
        }
        const non100PercentDistributions = creditDistributionOutcomes.filter(
          (outcome) =>
            outcome.distribution?.reduce(
              (acc, it) => acc + (it.amount ?? 0),
              0
            ) !== outcome.amount ?? 0
        );
        if (non100PercentDistributions.length) {
          throw new BadRequestException(
            `There are ${non100PercentDistributions.length} credit distribution outcomes where the distribution does not add up to total amount`
          );
        }
        const manualOutcomes = createWave.outcomes.filter(
          (it) => it.type === ApiWaveOutcomeType.Manual
        );
        if (manualOutcomes.length) {
          for (const manualOutcome of manualOutcomes) {
            if (!manualOutcome.distribution?.length) {
              throw new BadRequestException(
                `Outcome "${manualOutcome.description}" is missing described distribution`
              );
            }
            if (
              manualOutcome.distribution?.find(
                (it) => !it.description?.trim()?.length
              )
            ) {
              throw new BadRequestException(
                `Outcome "${manualOutcome.description}" has at least one distribution item with missing description`
              );
            }
          }
        }

        break;
      }
      case ApiWaveType.Chat: {
        if (createWave.outcomes.length) {
          throw new BadRequestException(
            `Waves of type ${ApiWaveType.Chat} can't have outcomes`
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
  ): Promise<ApiWave[]> {
    const authenticationContext = ctx.authenticationContext;
    let groupsUserIsEligibleFor: string[];
    if (!authenticationContext?.isUserFullyAuthenticated()) {
      groupsUserIsEligibleFor = [];
    } else {
      const authenticatedProfileId = authenticationContext.getActingAsId();
      if (
        authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ProfileProxyActionType.READ_WAVE
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
      groupsUserIsEligibleFor,
      ctx
    );
    const noRightToVote =
      !authenticationContext ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ProfileProxyActionType.RATE_WAVE_DROP
        ]);
    const noRightToParticipate =
      !authenticationContext ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ProfileProxyActionType.CREATE_DROP_TO_WAVE
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
  ): Promise<Record<string, ApiWave>> {
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
          ProfileProxyActionType.RATE_WAVE_DROP
        ]);
    const noRightToParticipate =
      !authenticationContext ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ProfileProxyActionType.CREATE_DROP_TO_WAVE
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
        }, {} as Record<string, ApiWave>)
      );
  }

  async findWaveByIdOrThrow(
    id: string,
    groupIdsUserIsEligibleFor: string[],
    ctx: RequestContext
  ): Promise<ApiWave> {
    const authenticationContext = ctx.authenticationContext;
    const entity = await this.wavesApiDb.findWaveById(id);
    if (
      !entity ||
      (entity.visibility_group_id !== null &&
        !groupIdsUserIsEligibleFor.includes(entity.visibility_group_id))
    ) {
      throw new NotFoundException(`Wave ${id} not found`);
    }
    const noRightToVote =
      !authenticationContext?.isUserFullyAuthenticated() ||
      (authenticationContext?.isAuthenticatedAsProxy() &&
        !authenticationContext?.hasProxyAction(
          ProfileProxyActionType.RATE_WAVE_DROP
        ));
    const noRightToParticipate =
      !authenticationContext?.isUserFullyAuthenticated() ||
      (authenticationContext?.isAuthenticatedAsProxy() &&
        !authenticationContext?.hasProxyAction(
          ProfileProxyActionType.CREATE_DROP_TO_WAVE
        ));
    return await this.waveMappers.waveEntityToApiWave(
      {
        waveEntity: entity,
        groupIdsUserIsEligibleFor,
        noRightToVote,
        noRightToParticipate
      },
      ctx
    );
  }

  async addWaveSubscriptionActions({
    subscriber,
    waveId,
    actions
  }: {
    subscriber: string;
    waveId: string;
    actions: ApiWaveSubscriptionTargetAction[];
  }): Promise<ApiWaveSubscriptionTargetAction[]> {
    const groupsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(subscriber);
    await this.findWaveByIdOrThrow(waveId, groupsUserIsEligibleFor, {});
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
              target_action: action,
              wave_id: waveId,
              subscribed_to_all_drops: false
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
              resolveEnumOrThrow(ApiWaveSubscriptionTargetAction, it)
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
    actions: ApiWaveSubscriptionTargetAction[];
  }): Promise<ApiWaveSubscriptionTargetAction[]> {
    const groupsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(subscriber);
    await this.findWaveByIdOrThrow(waveId, groupsUserIsEligibleFor, {});
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
              resolveEnumOrThrow(ApiWaveSubscriptionTargetAction, it)
            )
          );
      }
    );
  }

  public async getWavesOverview(
    {
      type,
      limit,
      offset,
      only_waves_followed_by_authenticated_user
    }: WavesOverviewParams,
    ctx: RequestContext
  ) {
    const authenticationContext = ctx?.authenticationContext;
    const authenticatedProfileId =
      authenticationContext?.getActingAsId() ?? null;
    if (!authenticatedProfileId) {
      if (
        only_waves_followed_by_authenticated_user ||
        [
          ApiWavesOverviewType.AuthorYouHaveRepped,
          ApiWavesOverviewType.MostDroppedByYou,
          ApiWavesOverviewType.RecentlyDroppedToByYou
        ].includes(type)
      ) {
        throw new BadRequestException(
          `You can't see waves organised by your behaviour unless you're authenticated`
        );
      }
    }
    const eligibleGroups =
      !authenticationContext ||
      !authenticatedProfileId ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ProfileProxyActionType.READ_WAVE
        ])
        ? []
        : await this.userGroupsService.getGroupsUserIsEligibleFor(
            authenticatedProfileId,
            ctx.timer
          );
    const entities = await this.findWaveEntitiesByType({
      type,
      limit,
      authenticatedUserId: authenticatedProfileId ?? null,
      eligibleGroups,
      only_waves_followed_by_authenticated_user,
      offset
    });
    const noRightToVote =
      !authenticationContext ||
      !authenticatedProfileId ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ProfileProxyActionType.RATE_WAVE_DROP
        ]);
    const noRightToParticipate =
      !authenticationContext ||
      !authenticatedProfileId ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ProfileProxyActionType.CREATE_DROP_TO_WAVE
        ]);
    return this.waveMappers.waveEntitiesToApiWaves(
      {
        waveEntities: entities,
        groupIdsUserIsEligibleFor: eligibleGroups,
        noRightToVote,
        noRightToParticipate
      },
      ctx
    );
  }

  private async findWaveEntitiesByType({
    eligibleGroups,
    type,
    authenticatedUserId,
    limit,
    only_waves_followed_by_authenticated_user,
    offset
  }: {
    eligibleGroups: string[];
    type: ApiWavesOverviewType;
    limit: number;
    offset: number;
    only_waves_followed_by_authenticated_user: boolean;
    authenticatedUserId: string | null;
  }): Promise<WaveEntity[]> {
    switch (type) {
      case ApiWavesOverviewType.Latest:
        return await this.wavesApiDb.findLatestWaves({
          only_waves_followed_by_authenticated_user,
          authenticated_user_id: authenticatedUserId,
          eligibleGroups,
          limit,
          offset
        });
      case ApiWavesOverviewType.MostSubscribed:
        return await this.wavesApiDb.findMostSubscribedWaves({
          only_waves_followed_by_authenticated_user,
          authenticated_user_id: authenticatedUserId,
          eligibleGroups,
          limit,
          offset
        });
      case ApiWavesOverviewType.HighLevelAuthor:
        return await this.wavesApiDb.findHighLevelAuthorWaves({
          only_waves_followed_by_authenticated_user,
          authenticated_user_id: authenticatedUserId,
          eligibleGroups,
          limit,
          offset
        });
      case ApiWavesOverviewType.AuthorYouHaveRepped:
        return await this.wavesApiDb.findWavesByAuthorsYouHaveRepped({
          eligibleGroups,
          authenticatedUserId: authenticatedUserId!,
          only_waves_followed_by_authenticated_user,
          limit,
          offset
        });
      case ApiWavesOverviewType.MostDropped:
        return await this.wavesApiDb.findMostDroppedWaves({
          eligibleGroups,
          authenticated_user_id: authenticatedUserId,
          only_waves_followed_by_authenticated_user,
          limit,
          offset
        });
      case ApiWavesOverviewType.MostDroppedByYou:
        return await this.wavesApiDb.findMostDroppedWavesByYou({
          eligibleGroups,
          only_waves_followed_by_authenticated_user,
          dropperId: authenticatedUserId!,
          authenticated_user_id: authenticatedUserId,
          limit,
          offset
        });
      case ApiWavesOverviewType.RecentlyDroppedTo:
        return await this.wavesApiDb.findRecentlyDroppedToWaves({
          eligibleGroups,
          only_waves_followed_by_authenticated_user,
          authenticated_user_id: authenticatedUserId,
          limit,
          offset
        });
      case ApiWavesOverviewType.RecentlyDroppedToByYou:
        return await this.wavesApiDb.findRecentlyDroppedToWavesByYou({
          only_waves_followed_by_authenticated_user,
          authenticated_user_id: authenticatedUserId,
          eligibleGroups,
          dropperId: authenticatedUserId!,
          limit,
          offset
        });
      default:
        assertUnreachable(type);
    }
    return []; // unreachable code but typescript doesn't know that
  }

  async deleteWave(waveId: string, ctx: RequestContext) {
    const authenticationContext = ctx.authenticationContext!;
    const authenticatedUserId = authenticationContext.getActingAsId();
    if (!authenticatedUserId) {
      throw new ForbiddenException(
        `You need to be authenticated and have a profile to delete a wave`
      );
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxies can't delete waves`);
    }
    await this.wavesApiDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctxWithConnection = { ...ctx, connection };
        const waveEntity = await this.wavesApiDb.findWaveById(
          waveId,
          connection
        );
        if (!waveEntity) {
          throw new NotFoundException(`Wave ${waveId} not found`);
        }
        const groupsUserIsEligibleFor =
          await this.userGroupsService.getGroupsUserIsEligibleFor(
            authenticatedUserId
          );
        if (waveEntity.created_by !== authenticatedUserId) {
          if (
            waveEntity.admin_group_id === null ||
            !groupsUserIsEligibleFor.includes(waveEntity.admin_group_id)
          ) {
            throw new ForbiddenException(
              `You can't delete a wave you didn't create and are not an admin of`
            );
          }
        }

        await Promise.all([
          this.wavesApiDb.deleteDropPartsByWaveId(waveId, ctxWithConnection),
          this.wavesApiDb.deleteDropMentionsByWaveId(waveId, ctxWithConnection),
          this.wavesApiDb.deleteDropMediaByWaveId(waveId, ctxWithConnection),
          this.wavesApiDb.deleteDropReferencedNftsByWaveId(
            waveId,
            ctxWithConnection
          ),
          this.wavesApiDb.deleteDropMetadataByWaveId(waveId, ctxWithConnection),
          this.wavesApiDb.deleteClapCreditSpendingsByWaveId(
            waveId,
            ctxWithConnection
          ),
          this.wavesApiDb.deleteDropClapsByWaveId(waveId, ctxWithConnection),
          this.wavesApiDb.deleteDropFeedItemsByWaveId(
            waveId,
            ctxWithConnection
          ),
          this.wavesApiDb.deleteDropNotificationsByWaveId(
            waveId,
            ctxWithConnection
          ),
          this.wavesApiDb.deleteDropSubscriptionsByWaveId(
            waveId,
            ctxWithConnection
          ),
          this.dropVotingService.deleteVoteByWave(waveId, ctxWithConnection),
          this.clappingService.deleteClapsByWave(waveId, ctxWithConnection),
          this.wavesApiDb.deleteDropEntitiesByWaveId(waveId, ctxWithConnection),
          this.wavesApiDb.deleteWaveMetrics(waveId, ctxWithConnection),
          this.wavesApiDb.deleteWave(waveId, ctxWithConnection),
          this.wavesApiDb.deleteDropRelations(waveId, ctxWithConnection)
        ]);
      }
    );
  }

  async updateWave(
    waveId: string,
    request: ApiUpdateWaveRequest,
    ctx: RequestContext
  ): Promise<ApiWave> {
    const authenticationContext = ctx.authenticationContext!;
    const authenticatedProfileId = authenticationContext.authenticatedProfileId;
    if (!authenticatedProfileId) {
      throw new ForbiddenException(
        `You need to be authenticated and have a profile to update a wave`
      );
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxies can't update waves`);
    }
    const groupsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        authenticatedProfileId
      );
    return await this.wavesApiDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctxWithConnection = { ...ctx, connection };
        await this.validateWaveRelations(request, ctxWithConnection);
        const waveBeforeUpdate = await this.wavesApiDb.findWaveById(
          waveId,
          connection
        );
        if (!waveBeforeUpdate) {
          throw new NotFoundException(`Wave ${waveId} not found`);
        }
        if (waveBeforeUpdate.created_by !== authenticatedProfileId) {
          if (
            waveBeforeUpdate.admin_group_id === null ||
            !groupsUserIsEligibleFor.includes(waveBeforeUpdate.admin_group_id)
          ) {
            throw new ForbiddenException(
              `You can't update a wave you didn't create and are not an admin of`
            );
          }
        }
        await this.wavesApiDb.deleteWave(waveId, ctxWithConnection);
        const updatedEntity = await this.waveMappers.createWaveToNewWaveEntity(
          waveId,
          waveBeforeUpdate.serial_no,
          waveBeforeUpdate.created_at,
          Time.currentMillis(),
          request,
          waveBeforeUpdate.created_by,
          waveBeforeUpdate.description_drop_id
        );
        await this.wavesApiDb.insertWave(updatedEntity, ctxWithConnection);
        const newVisibilityGroupId = request.visibility.scope.group_id;
        const oldVisibilityGroupId = waveBeforeUpdate.visibility_group_id;
        if (newVisibilityGroupId !== oldVisibilityGroupId) {
          await Promise.all([
            this.wavesApiDb.updateVisibilityInFeedEntities(
              { waveId, newVisibilityGroupId },
              ctxWithConnection
            ),
            this.wavesApiDb.updateVisibilityInNotifications(
              { waveId, newVisibilityGroupId },
              ctxWithConnection
            )
          ]);
        }
        const noRightToVote =
          authenticationContext.isAuthenticatedAsProxy() &&
          !authenticationContext.activeProxyActions[
            ProfileProxyActionType.RATE_WAVE_DROP
          ];
        const noRightToParticipate =
          authenticationContext.isAuthenticatedAsProxy() &&
          !authenticationContext.activeProxyActions[
            ProfileProxyActionType.CREATE_DROP_TO_WAVE
          ];
        const waveEntity = await this.wavesApiDb.findWaveById(
          waveId,
          connection
        );
        return await this.waveMappers.waveEntityToApiWave(
          {
            waveEntity: waveEntity!,
            groupIdsUserIsEligibleFor: groupsUserIsEligibleFor,
            noRightToVote,
            noRightToParticipate
          },
          ctxWithConnection
        );
      }
    );
  }
}

export interface WavesOverviewParams {
  limit: number;
  offset: number;
  type: ApiWavesOverviewType;
  only_waves_followed_by_authenticated_user: boolean;
}

export const waveApiService = new WaveApiService(
  wavesApiDb,
  userGroupsService,
  wavesMappers,
  activityRecorder,
  identitySubscriptionsDb,
  createOrUpdateDrop,
  dropsMappers,
  dropVotingService,
  clappingService
);
