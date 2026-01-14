import { randomUUID } from 'crypto';
import {
  activityRecorder,
  ActivityRecorder
} from '../../../activity/activity.recorder';
import { assertUnreachable } from '../../../assertions';
import { AuthenticationContext } from '../../../auth-context';
import { collections } from '../../../collections';
import {
  createOrUpdateDrop,
  CreateOrUpdateDropUseCase
} from '../../../drops/create-or-update-drop.use-case';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '../../../entities/IActivityEvent';
import { ProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import { UserGroupEntity } from '../../../entities/IUserGroup';
import {
  WaveEntity,
  WaveOutcomeCredit,
  WaveOutcomeDistributionItemEntity,
  WaveOutcomeEntity,
  WaveOutcomeSubType,
  WaveOutcomeType
} from '../../../entities/IWave';
import { enums } from '../../../enums';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../../../exceptions';
import {
  userNotifier,
  UserNotifier
} from '../../../notifications/user.notifier';
import { numbers } from '../../../numbers';
import { RequestContext } from '../../../request.context';
import { Time } from '../../../time';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import {
  dropVotingService,
  DropVotingService
} from '../drops/drop-voting.service';
import { dropsMappers, DropsMappers } from '../drops/drops.mappers';
import { reactionsService, ReactionsService } from '../drops/reactions.service';
import { ApiCreateNewWave } from '../generated/models/ApiCreateNewWave';
import { ApiDropType } from '../generated/models/ApiDropType';
import { ApiGroupFull } from '../generated/models/ApiGroupFull';
import { ApiUpdateWaveDecisionPause } from '../generated/models/ApiUpdateWaveDecisionPause';
import { ApiUpdateWaveRequest } from '../generated/models/ApiUpdateWaveRequest';
import { ApiWave } from '../generated/models/ApiWave';
import { ApiWaveCreditScope } from '../generated/models/ApiWaveCreditScope';
import { ApiWaveCreditType } from '../generated/models/ApiWaveCreditType';
import { ApiWaveDecisionsStrategy } from '../generated/models/ApiWaveDecisionsStrategy';
import { ApiWaveOutcomeSubType } from '../generated/models/ApiWaveOutcomeSubType';
import { ApiWaveOutcomeType } from '../generated/models/ApiWaveOutcomeType';
import { ApiWaveSubscriptionTargetAction } from '../generated/models/ApiWaveSubscriptionTargetAction';
import { ApiWaveType } from '../generated/models/ApiWaveType';
import { ApiWavesOverviewType } from '../generated/models/ApiWavesOverviewType';
import { ApiWavesPinFilter } from '../generated/models/ApiWavesPinFilter';
import {
  IdentityFetcher,
  identityFetcher
} from '../identities/identity.fetcher';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import { SearchWavesParams, wavesApiDb, WavesApiDb } from './waves.api.db';
import { wavesMappers, WavesMappers } from './waves.mappers';
import { clearWaveGroupsCache } from '../../../redis';
import {
  metricsRecorder,
  MetricsRecorder
} from '../../../metrics/MetricsRecorder';

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
    private readonly reactionsService: ReactionsService,
    private readonly userNotifier: UserNotifier,
    private readonly identityFetcher: IdentityFetcher,
    private readonly metricsRecorder: MetricsRecorder
  ) {}

  public async createWave(
    createWaveRequest: ApiCreateNewWave,
    isDirectMessage: boolean,
    ctx: RequestContext
  ): Promise<ApiWave> {
    const timer = ctx.timer!;
    const authenticationContext = ctx.authenticationContext!;
    timer.start(`${this.constructor.name}->createWave`);
    await this.validateWaveRelations(createWaveRequest, ctx);
    this.validateOutcomes(createWaveRequest);
    const createdWave = await this.wavesApiDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctxWithConnection = { ...ctx, connection };
        const id = randomUUID();
        const waveCreationTime = Time.currentMillis();
        const newEntity = await this.waveMappers.createWaveToNewWaveEntity({
          id,
          serial_no: null,
          created_at: waveCreationTime,
          updated_at: null,
          request: createWaveRequest,
          created_by: authenticationContext.getActingAsId()!,
          descriptionDropId: randomUUID(),
          nextDecisionTime: this.calculateNextDecisionTimeRelativeToNow(
            waveCreationTime,
            createWaveRequest.wave.decisions_strategy
          ),
          outcomes: [],
          isDirectMessage
        });
        await this.wavesApiDb.insertWave(newEntity, ctxWithConnection);
        const apiOutcomes = createWaveRequest.outcomes;
        const outcomeEntities: WaveOutcomeEntity[] = [];
        const distiributionItemEntities: WaveOutcomeDistributionItemEntity[] =
          [];
        for (
          let outcomeIndex = 1;
          outcomeIndex <= apiOutcomes.length;
          outcomeIndex++
        ) {
          const apiOutcome = apiOutcomes[outcomeIndex - 1]!;
          outcomeEntities.push({
            wave_id: id,
            type: enums.resolveOrThrow(WaveOutcomeType, apiOutcome.type),
            subtype: apiOutcome.subtype
              ? enums.resolveOrThrow(WaveOutcomeSubType, apiOutcome.subtype)
              : null,
            description: apiOutcome.description,
            credit: apiOutcome.credit
              ? enums.resolveOrThrow(WaveOutcomeCredit, apiOutcome.credit)
              : null,
            rep_category: apiOutcome.rep_category ?? null,
            amount: apiOutcome.amount ?? null,
            wave_outcome_position: outcomeIndex
          });
          const apiDistributionItems = apiOutcome.distribution ?? [];
          for (
            let distributionItemIndex = 1;
            distributionItemIndex <= apiDistributionItems.length;
            distributionItemIndex++
          ) {
            const apiDistributionItem =
              apiDistributionItems[distributionItemIndex - 1]!;
            distiributionItemEntities.push({
              amount: numbers.parseIntOrNull(apiDistributionItem.amount),
              description: apiDistributionItem.description ?? null,
              wave_outcome_position: outcomeIndex,
              wave_outcome_distribution_item_position: distributionItemIndex,
              wave_id: id
            });
          }
        }
        await this.wavesApiDb.insertOutcomes(
          outcomeEntities,
          ctxWithConnection
        );
        await this.wavesApiDb.insertOutcomeDistributionItems(
          distiributionItemEntities,
          ctxWithConnection
        );
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
        await this.metricsRecorder.recordActiveIdentity(
          { identityId: newEntity.created_by },
          ctxWithConnection
        );
        await this.identitySubscriptionsDb.addIdentitySubscription(
          {
            subscriber_id: newEntity.created_by,
            target_id: id,
            target_type: ActivityEventTargetType.WAVE,
            target_action: ActivityEventAction.DROP_CREATED,
            wave_id: id,
            subscribed_to_all_drops: newEntity.is_direct_message
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

        const waveGroups = Array.from(
          new Set<string>(
            [
              waveEntity.visibility_group_id,
              waveEntity.participation_group_id,
              waveEntity.chat_group_id,
              waveEntity.admin_group_id
            ].filter((it): it is string => it !== null)
          )
        );

        await this.activityRecorder.recordWaveCreated(
          {
            creator_id: waveEntity.created_by,
            wave_id: id,
            visibility_group_id: waveEntity.visibility_group_id
          },
          ctxWithConnection
        );
        let usersToNotify: string[];
        if (waveEntity.is_direct_message) {
          usersToNotify = await this.userGroupsService.findIdentitiesInGroups(
            waveGroups,
            ctxWithConnection
          );
        } else {
          usersToNotify =
            await this.userGroupsService.findFollowersOfUserInGroups(
              waveEntity.created_by,
              waveGroups,
              ctxWithConnection
            );
        }
        await this.userNotifier.notifyOfWaveCreated(
          waveEntity.id,
          waveEntity.created_by,
          usersToNotify,
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
    await clearWaveGroupsCache();
    timer.stop(`${this.constructor.name}->createWave`);
    return createdWave;
  }

  public async createOrUpdateWavePause(
    waveId: string,
    model: ApiUpdateWaveDecisionPause,
    ctx: RequestContext
  ): Promise<ApiWave> {
    const wave = await this.assertUserAllowedToModifyPauses(ctx, waveId);
    await this.assertProposedPauseValidForAddOrUpdate(wave, model, ctx);
    await this.wavesApiDb.executeNativeQueriesInTransaction(
      async (connection) => {
        if (model.id) {
          await this.wavesApiDb.deletePause(model.id, connection);
        }
        await this.wavesApiDb.insertPause(
          { startTime: model.start_time, endTime: model.end_time, waveId },
          connection
        );
      }
    );
    await giveReadReplicaTimeToCatchUp();
    const groupsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        ctx.authenticationContext!.getActingAsId()
      );
    return this.findWaveByIdOrThrow(waveId, groupsUserIsEligibleFor, ctx);
  }

  public async deleteWavePause(
    waveId: string,
    pauseId: number,
    ctx: RequestContext
  ): Promise<ApiWave> {
    const wave = await this.assertUserAllowedToModifyPauses(ctx, waveId);
    await this.assertProposedPauseValidForDeletion(wave, pauseId, ctx);
    await this.wavesApiDb.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.wavesApiDb.deletePause(pauseId, connection);
      }
    );
    await giveReadReplicaTimeToCatchUp();
    const groupsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        ctx.authenticationContext!.getActingAsId()
      );
    return this.findWaveByIdOrThrow(waveId, groupsUserIsEligibleFor, ctx);
  }

  private async assertProposedPauseValidForAddOrUpdate(
    wave: WaveEntity,
    model: ApiUpdateWaveDecisionPause,
    ctx: RequestContext
  ) {
    const decisionStrategy = wave.decisions_strategy;
    if (decisionStrategy === null) {
      throw new BadRequestException(
        `Can't add pauses to wave without a decision strategy`
      );
    }
    const nextDecisionTime = wave.next_decision_time
      ? Time.millis(wave.next_decision_time)
      : null;
    if (!nextDecisionTime) {
      throw new BadRequestException(
        `Can't add pauses to wave without a next decision time`
      );
    }
    const proposedEndTime = Time.millis(model.end_time);
    if (proposedEndTime.isInPast()) {
      throw new BadRequestException(`Can't modify end_time to be in past`);
    }
    if (nextDecisionTime.isInPast()) {
      throw new BadRequestException(
        `Can't modify pauses of a wave with unresolved decisions`
      );
    }
    const currentPauses = await this.wavesApiDb.getWavePauses(wave.id, ctx);
    const proposedStartTime = Time.millis(model.start_time);
    const pauseIdToUpdate = model.id;
    const otherPauses = currentPauses.filter(
      (it) =>
        numbers.parseIntOrNull(it.id) !==
        numbers.parseIntOrNull(pauseIdToUpdate)
    );
    const overLappingPause = otherPauses.find((it) => {
      const otherPausesStart = Time.millis(it.start_time);
      const otherPausesEnd = Time.millis(it.end_time);
      return proposedStartTime.isInInterval(otherPausesStart, otherPausesEnd);
    });
    if (overLappingPause) {
      throw new BadRequestException(
        `Can not create a pause which is overlapping with another pause`
      );
    }
    if (pauseIdToUpdate) {
      const pauseToModify = currentPauses.find((it) => it.id === model.id);
      if (!pauseToModify) {
        throw new NotFoundException(
          `Pause ${pauseIdToUpdate} for wave ${wave.id} not found`
        );
      }
      if (Time.millis(pauseToModify.end_time).isInPast()) {
        throw new BadRequestException(
          `Can't modify a past which's end_time is already over`
        );
      }
      const oldStartTime = Time.millis(+pauseToModify.start_time);
      const newStartTime = Time.millis(model.start_time);
      if (!oldStartTime.eq(newStartTime)) {
        throw new BadRequestException(`Pause start time can not be updated`);
      }
    }
  }

  private async assertProposedPauseValidForDeletion(
    wave: WaveEntity,
    pauseId: number,
    ctx: RequestContext
  ) {
    const nextDecisionTime = wave.next_decision_time
      ? Time.millis(wave.next_decision_time)
      : null;
    if (!nextDecisionTime) {
      throw new BadRequestException(
        `Can't add pauses to wave without a next decision time`
      );
    }
    if (nextDecisionTime.isInPast()) {
      throw new BadRequestException(
        `Can't modify pauses of a wave with unresolved decisions`
      );
    }
    const currentPauses = await this.wavesApiDb.getWavePauses(wave.id, ctx);
    const pauseToDelete = currentPauses.find((it) => it.id === pauseId);
    if (!pauseToDelete) {
      throw new NotFoundException(
        `Pause ${pauseToDelete} for wave ${wave.id} not found`
      );
    }
    if (Time.millis(pauseToDelete.end_time).isInPast()) {
      throw new BadRequestException(
        `Can't modify a pause which's end_time is already over`
      );
    }
  }

  private async assertUserAllowedToModifyPauses(
    ctx: RequestContext,
    waveId: string
  ) {
    const authContext = ctx.authenticationContext;
    const authenticatedUserId = authContext?.getActingAsId();
    if (!authenticatedUserId) {
      throw new ForbiddenException(`User must be authenticated`);
    }
    if (authContext!.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`This action can not be done as proxy`);
    }
    const wave = await this.wavesApiDb.findById(waveId);
    if (!wave) {
      throw new NotFoundException(`Wave not found`);
    }
    if (wave.created_by !== authenticatedUserId) {
      const adminGroupId = wave.admin_group_id;
      if (!adminGroupId) {
        throw new ForbiddenException(
          `Wave modification not allowed for authenticated user`
        );
      }
      const isUserInAdminGroup = await this.userGroupsService
        .getGroupsUserIsEligibleFor(authenticatedUserId, ctx.timer)
        .then((it) => it.includes(authenticatedUserId));
      if (!isUserInAdminGroup) {
        throw new ForbiddenException(
          `Wave modification not allowed for authenticated user`
        );
      }
    }
    return wave;
  }

  public async findOrCreateDirectMessageWave(
    userGroup: ApiGroupFull | UserGroupEntity,
    ctx: RequestContext
  ) {
    const existingWave = await this.wavesApiDb.findWaveByGroupId(
      userGroup.id,
      ctx
    );
    if (existingWave) {
      return this.findWaveByIdOrThrow(existingWave.id, [userGroup.id], ctx);
    }
    const waveRequest: ApiCreateNewWave = {
      name: userGroup.name,
      description_drop: {
        title: null,
        signature: null,
        parts: [
          {
            content: 'gm! :gm1:',
            quoted_drop: null,
            media: []
          }
        ],
        referenced_nfts: [],
        mentioned_users: [],
        metadata: []
      },
      picture: null,
      voting: {
        scope: {
          group_id: null
        },
        credit_type: ApiWaveCreditType.Tdh,
        credit_scope: ApiWaveCreditScope.Wave,
        credit_category: null,
        creditor_id: null,
        signature_required: false,
        period: {
          min: null,
          max: null
        },
        forbid_negative_votes: false
      },
      visibility: {
        scope: {
          group_id: userGroup.id
        }
      },
      participation: {
        scope: {
          group_id: userGroup.id
        },
        no_of_applications_allowed_per_participant: null,
        required_media: [],
        required_metadata: [],
        signature_required: false,
        period: {
          min: null,
          max: null
        },
        terms: null
      },
      chat: {
        scope: {
          group_id: userGroup.id
        },
        enabled: true
      },
      wave: {
        type: ApiWaveType.Chat,
        winning_thresholds: null,
        max_winners: null,
        time_lock_ms: null,
        admin_group: {
          group_id: userGroup.id
        },
        decisions_strategy: null,
        admin_drop_deletion_enabled: false
      },
      outcomes: []
    };

    return await this.createWave(waveRequest, true, ctx);
  }

  private async validateWaveRelations(
    request: ApiCreateNewWave | ApiUpdateWaveRequest,
    ctx: RequestContext
  ) {
    const timer = ctx.timer;
    timer?.start(`${this.constructor.name}->validateWaveRelations`);
    if (request.wave.type === ApiWaveType.Chat && !request.chat.enabled) {
      throw new BadRequestException(`Chat waves need to have chat enabled`);
    }
    if (request.voting.signature_required) {
      throw new BadRequestException(
        `Creating a wave with signed votes requirement is not yet supported`
      );
    }
    if (request.wave.decisions_strategy !== null) {
      if (request.wave.type !== ApiWaveType.Rank) {
        throw new BadRequestException(
          `Only waves of type RANK support a decision strategy.`
        );
      }
      if (
        request.wave.decisions_strategy.is_rolling &&
        !request.wave.decisions_strategy.subsequent_decisions.length
      ) {
        throw new BadRequestException(
          `On rolling decision strategy subsequent decisions is mandatory`
        );
      }
    }
    const referencedGroupIds = collections.distinct(
      [
        request.visibility.scope.group_id,
        request.participation.scope.group_id,
        request.voting.scope.group_id
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
    const referencedCreditorIdentity = request.voting.creditor_id;
    if (referencedCreditorIdentity) {
      const profileId = await this.identityFetcher.getProfileIdByIdentityKey(
        {
          identityKey: referencedCreditorIdentity
        },
        ctx
      );
      if (!profileId) {
        throw new NotFoundException(
          `${referencedCreditorIdentity} doesn't have a profile`
        );
      }
    }
    timer?.stop(`${this.constructor.name}->validateWaveRelations`);
  }

  private validateOutcomes(createWave: ApiCreateNewWave) {
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
            ) !== (outcome.amount ?? 0)
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
        res.reduce(
          (acc, it) => {
            acc[it.id] = it;
            return acc;
          },
          {} as Record<string, ApiWave>
        )
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
      enums.resolveOrThrow(ActivityEventAction, it)
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
        await this.metricsRecorder.recordActiveIdentity(
          { identityId: subscriber },
          { connection }
        );
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
              enums.resolveOrThrow(ApiWaveSubscriptionTargetAction, it)
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
              target_action: enums.resolveOrThrow(ActivityEventAction, action)
            },
            connection
          );
        }
        await this.metricsRecorder.recordActiveIdentity(
          { identityId: subscriber },
          { connection }
        );
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
              enums.resolveOrThrow(ApiWaveSubscriptionTargetAction, it)
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
      only_waves_followed_by_authenticated_user,
      direct_message,
      pinned
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
      direct_message,
      offset,
      pinned
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
    direct_message,
    offset,
    pinned
  }: {
    eligibleGroups: string[];
    type: ApiWavesOverviewType;
    limit: number;
    offset: number;
    only_waves_followed_by_authenticated_user: boolean;
    authenticatedUserId: string | null;
    direct_message?: boolean;
    pinned: ApiWavesPinFilter | null;
  }): Promise<WaveEntity[]> {
    switch (type) {
      case ApiWavesOverviewType.Latest:
        return await this.wavesApiDb.findLatestWaves({
          only_waves_followed_by_authenticated_user,
          authenticated_user_id: authenticatedUserId,
          eligibleGroups,
          limit,
          offset,
          direct_message,
          pinned
        });
      case ApiWavesOverviewType.MostSubscribed:
        return await this.wavesApiDb.findMostSubscribedWaves({
          only_waves_followed_by_authenticated_user,
          authenticated_user_id: authenticatedUserId,
          eligibleGroups,
          limit,
          offset,
          direct_message,
          pinned
        });
      case ApiWavesOverviewType.HighLevelAuthor:
        return await this.wavesApiDb.findHighLevelAuthorWaves({
          only_waves_followed_by_authenticated_user,
          authenticated_user_id: authenticatedUserId,
          eligibleGroups,
          limit,
          offset,
          direct_message,
          pinned
        });
      case ApiWavesOverviewType.AuthorYouHaveRepped:
        return await this.wavesApiDb.findWavesByAuthorsYouHaveRepped({
          eligibleGroups,
          authenticatedUserId: authenticatedUserId!,
          only_waves_followed_by_authenticated_user,
          limit,
          offset,
          direct_message,
          pinned
        });
      case ApiWavesOverviewType.MostDropped:
        return await this.wavesApiDb.findMostDroppedWaves({
          eligibleGroups,
          authenticated_user_id: authenticatedUserId,
          only_waves_followed_by_authenticated_user,
          limit,
          offset,
          direct_message,
          pinned
        });
      case ApiWavesOverviewType.MostDroppedByYou:
        return await this.wavesApiDb.findMostDroppedWavesByYou({
          eligibleGroups,
          only_waves_followed_by_authenticated_user,
          dropperId: authenticatedUserId!,
          authenticated_user_id: authenticatedUserId,
          limit,
          offset,
          direct_message,
          pinned
        });
      case ApiWavesOverviewType.RecentlyDroppedTo:
        return await this.wavesApiDb.findRecentlyDroppedToWaves({
          eligibleGroups,
          only_waves_followed_by_authenticated_user,
          authenticated_user_id: authenticatedUserId,
          limit,
          offset,
          direct_message,
          pinned
        });
      case ApiWavesOverviewType.RecentlyDroppedToByYou:
        return await this.wavesApiDb.findRecentlyDroppedToWavesByYou({
          only_waves_followed_by_authenticated_user,
          authenticated_user_id: authenticatedUserId,
          eligibleGroups,
          dropperId: authenticatedUserId!,
          limit,
          offset,
          direct_message,
          pinned
        });
      default:
        assertUnreachable(type);
    }
    return []; // unreachable code but TS doesn't know that
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

        if (
          waveEntity.next_decision_time !== null &&
          waveEntity.next_decision_time < Time.currentMillis()
        ) {
          throw new ForbiddenException(
            `Wave has unresolved decisions and can't be edited at the moment. Try again later`
          );
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
          this.reactionsService.deleteReactionsByWave(
            waveId,
            ctxWithConnection
          ),
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
          this.reactionsService.deleteReactionsByWave(
            waveId,
            ctxWithConnection
          ),
          this.wavesApiDb.deleteDropEntitiesByWaveId(waveId, ctxWithConnection),
          this.wavesApiDb.deleteWaveMetrics(waveId, ctxWithConnection),
          this.wavesApiDb.deleteWave(waveId, ctxWithConnection),
          this.wavesApiDb.deleteWaveOutcomes(waveId, ctxWithConnection),
          this.wavesApiDb.deleteWaveOutcomeDistributionItems(
            waveId,
            ctxWithConnection
          ),
          this.wavesApiDb.deleteDropRelations(waveId, ctxWithConnection),
          this.wavesApiDb.deleteBoosts(waveId, ctxWithConnection),
          this.metricsRecorder.recordActiveIdentity(
            { identityId: authenticatedUserId },
            ctxWithConnection
          )
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
        if (
          waveBeforeUpdate.next_decision_time !== null &&
          waveBeforeUpdate.next_decision_time < Time.currentMillis()
        ) {
          throw new ForbiddenException(
            `Wave has unresolved decisions and can't be edited at the moment. Try again later`
          );
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
        const waveUpdateTime = Time.currentMillis();
        const updatedEntity = await this.waveMappers.createWaveToNewWaveEntity({
          id: waveId,
          serial_no: waveBeforeUpdate.serial_no,
          created_at: waveBeforeUpdate.created_at,
          updated_at: waveUpdateTime,
          request,
          created_by: waveBeforeUpdate.created_by,
          descriptionDropId: waveBeforeUpdate.description_drop_id,
          nextDecisionTime: this.calculateNextDecisionTimeRelativeToNow(
            waveUpdateTime,
            request.wave.decisions_strategy
          ),
          outcomes: [],
          isDirectMessage: waveBeforeUpdate.is_direct_message ?? false
        });

        await this.wavesApiDb.insertWave(updatedEntity, ctxWithConnection);
        await this.metricsRecorder.recordActiveIdentity(
          { identityId: authenticatedProfileId },
          ctxWithConnection
        );
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

  private calculateNextDecisionTimeRelativeToNow(
    currentMillis: number,
    decisionStrategy: ApiWaveDecisionsStrategy | null
  ): number | null {
    if (!decisionStrategy) {
      return null;
    }
    let decisionTime: number | null = decisionStrategy.first_decision_time;
    const subsequentDecisions = decisionStrategy.subsequent_decisions;
    const isRolling = decisionStrategy.is_rolling;
    let subsequentDecisionPointer = 0;
    while (decisionTime !== null && decisionTime < currentMillis) {
      subsequentDecisionPointer = this.getNextDecisionPointer(
        subsequentDecisions,
        subsequentDecisionPointer,
        isRolling
      );
      if (subsequentDecisionPointer === -1) {
        decisionTime = null;
      } else {
        decisionTime += subsequentDecisions[subsequentDecisionPointer];
      }
    }
    return decisionTime;
  }

  private getNextDecisionPointer(
    subsequentDecisions: number[],
    subsequentDecisionPointer: number,
    isRolling: boolean
  ): number {
    if (!subsequentDecisions.length) {
      return -1;
    }
    if (isRolling) {
      if (subsequentDecisionPointer === subsequentDecisions.length - 1) {
        return 0;
      }
      return subsequentDecisionPointer + 1;
    }
    if (subsequentDecisionPointer === subsequentDecisions.length - 1) {
      return -1;
    }
    return subsequentDecisionPointer + 1;
  }

  async pinWave({ waveId }: { waveId: string }, ctx: RequestContext) {
    await this.wavesApiDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctxWithConnection = { ...ctx, connection };
        await this.assertWaveExistsForAuthenticatedUser(
          waveId,
          ctxWithConnection
        );
        const actingAsId = ctx.authenticationContext?.getActingAsId();
        await this.wavesApiDb.insertPin(
          { waveId, profileId: actingAsId! },
          ctxWithConnection
        );
        if (actingAsId) {
          await this.metricsRecorder.recordActiveIdentity(
            { identityId: actingAsId },
            ctxWithConnection
          );
        }
      }
    );
  }

  async unPinWave({ waveId }: { waveId: string }, ctx: RequestContext) {
    await this.wavesApiDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctxWithConnection = {
          ...ctx,
          connection
        };
        await this.assertWaveExistsForAuthenticatedUser(
          waveId,
          ctxWithConnection
        );
        const actingAsId = ctx.authenticationContext?.getActingAsId();
        await this.wavesApiDb.deletePin(
          { waveId, profileId: actingAsId! },
          ctxWithConnection
        );
        if (actingAsId) {
          await this.metricsRecorder.recordActiveIdentity(
            { identityId: actingAsId },
            ctxWithConnection
          );
        }
      }
    );
  }

  async muteWave({ waveId }: { waveId: string }, ctx: RequestContext) {
    await this.wavesApiDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctxWithConnection = { ...ctx, connection };
        await this.assertWaveExistsForAuthenticatedUser(
          waveId,
          ctxWithConnection
        );
        const actingAsId = ctx.authenticationContext?.getActingAsId();
        await this.wavesApiDb.setWaveMuted(
          {
            waveId,
            readerId: actingAsId!,
            muted: true
          },
          ctxWithConnection
        );
        if (actingAsId) {
          await this.metricsRecorder.recordActiveIdentity(
            { identityId: actingAsId },
            ctxWithConnection
          );
        }
      }
    );
  }

  async unmuteWave({ waveId }: { waveId: string }, ctx: RequestContext) {
    await this.wavesApiDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctxWithConnection = { ...ctx, connection };
        await this.assertWaveExistsForAuthenticatedUser(
          waveId,
          ctxWithConnection
        );
        const actingAsId = ctx.authenticationContext?.getActingAsId();
        await this.wavesApiDb.setWaveMuted(
          {
            waveId,
            readerId: actingAsId!,
            muted: false
          },
          ctxWithConnection
        );
        if (actingAsId) {
          await this.metricsRecorder.recordActiveIdentity(
            { identityId: actingAsId },
            ctxWithConnection
          );
        }
      }
    );
  }

  private async assertWaveExistsForAuthenticatedUser(
    waveId: string,
    ctx: RequestContext
  ) {
    const waveEntity = await this.wavesApiDb.findWaveById(
      waveId,
      ctx.connection
    );
    if (!waveEntity) {
      throw new NotFoundException(`Wave ${waveId} not found.`);
    }
    const groupsUserIsEligibleFor =
      await userGroupsService.getGroupsUserIsEligibleFor(
        ctx.authenticationContext!.getActingAsId(),
        ctx.timer
      );
    if (
      waveEntity.visibility_group_id &&
      !groupsUserIsEligibleFor.includes(waveEntity.visibility_group_id)
    ) {
      throw new NotFoundException(`Wave ${waveId} not found.`);
    }
  }
}

export interface WavesOverviewParams {
  limit: number;
  offset: number;
  type: ApiWavesOverviewType;
  only_waves_followed_by_authenticated_user: boolean;
  direct_message?: boolean;
  pinned: ApiWavesPinFilter | null;
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
  reactionsService,
  userNotifier,
  identityFetcher,
  metricsRecorder
);
