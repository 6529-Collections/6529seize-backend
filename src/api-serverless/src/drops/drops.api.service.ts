import {
  DropLogsQueryParams,
  dropsDb,
  DropsDb,
  DropVotersStatsParams,
  LeaderboardParams,
  LeaderboardSort
} from '@/drops/drops.db';
import { ConnectionWrapper } from '@/sql-executor';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import { ApiDrop } from '../generated/models/ApiDrop';
import {
  UserGroupsService,
  userGroupsService
} from '../community-members/user-groups.service';
import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { ApiDropSubscriptionTargetAction } from '../generated/models/ApiDropSubscriptionTargetAction';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import {
  identitySubscriptionsDb,
  IdentitySubscriptionsDb
} from '../identity-subscriptions/identity-subscriptions.db';
import { dropsMappers, DropsMappers } from './drops.mappers';
import { RequestContext } from '@/request.context';
import { wavesApiDb } from '../waves/waves.api.db';
import { ApiDropTraceItem } from '../generated/models/ApiDropTraceItem';
import { ApiDropSearchStrategy } from '../generated/models/ApiDropSearchStrategy';
import { ApiDropType } from '../generated/models/ApiDropType';
import { DropEntity, DropType } from '@/entities/IDrop';
import { ApiWaveDropsFeed } from '../generated/models/ApiWaveDropsFeed';
import { ApiDropsLeaderboardPage } from '../generated/models/ApiDropsLeaderboardPage';
import { WaveType } from '@/entities/IWave';
import { ApiWaveLog } from '../generated/models/ApiWaveLog';
import {
  ProfileActivityLog,
  ProfileActivityLogType
} from '@/entities/IProfileActivityLog';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { ApiWaveVotersPage } from '../generated/models/ApiWaveVotersPage';
import { ApiWaveVoter } from '../generated/models/ApiWaveVoter';
import {
  identityFetcher,
  IdentityFetcher
} from '../identities/identity.fetcher';
import { ApiLightDrop } from '../generated/models/ApiLightDrop';
import { ApiDropMedia } from '../generated/models/ApiDropMedia';
import { enums } from '@/enums';
import { ApiCurationDrop } from '@/api/generated/models/ApiCurationDrop';
import { ApiCurationDropsPage } from '@/api/generated/models/ApiCurationDropsPage';
import { ApiDropWithoutWavesPageWithoutCount } from '../generated/models/ApiDropWithoutWavesPageWithoutCount';
import { ApiPageSortDirection } from '../generated/models/ApiPageSortDirection';
import { ApiDropsPage } from '../generated/models/ApiDropsPage';
import { ApiDropBoostsPage } from '../generated/models/ApiDropBoostsPage';
import { ApiDropId } from '../generated/models/ApiDropId';
import { metricsRecorder, MetricsRecorder } from '@/metrics/MetricsRecorder';
import { userNotifier } from '@/notifications/user.notifier';
import {
  wsListenersNotifier,
  WsListenersNotifier
} from '../ws/ws-listeners-notifier';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { CurationsDb, curationsDb } from '@/api/curations/curations.db';
import { directMessageWaveDisplayService } from '@/api/waves/direct-message-wave-display.service';
import {
  assertWaveVisibleOrThrow,
  getGroupsUserIsEligibleForReadContext,
  getWaveReadContextProfileId
} from '@/api/waves/wave-access.helpers';
import {
  getWaveMinPermissionMask,
  mapWaveToApiWaveMin
} from '@/api/waves/wave-min.helpers';
import { profileWavesDb } from '@/profiles/profile-waves.db';

export class DropsApiService {
  constructor(
    private readonly dropsMappers: DropsMappers,
    private readonly dropsDb: DropsDb,
    private readonly curationsDb: CurationsDb,
    private readonly userGroupsService: UserGroupsService,
    private readonly identitySubscriptionsDb: IdentitySubscriptionsDb,
    private readonly identityFetcher: IdentityFetcher,
    private readonly metricsRecorder: MetricsRecorder,
    private readonly wsListenersNotifier: WsListenersNotifier
  ) {}

  public async findDropByIdOrThrow(
    {
      dropId,
      skipEligibilityCheck
    }: {
      dropId: string;
      skipEligibilityCheck?: boolean;
    },
    ctx: RequestContext
  ): Promise<ApiDrop> {
    const contextProfileId = getWaveReadContextProfileId(
      ctx.authenticationContext
    );
    const group_ids_user_is_eligible_for =
      await this.userGroupsService.getGroupsUserIsEligibleFor(contextProfileId);
    const dropEntity = await (
      skipEligibilityCheck
        ? this.dropsDb.findDropByIdWithoutEligibilityCheck(
            dropId,
            ctx.connection
          )
        : this.dropsDb.findDropByIdWithEligibilityCheck(
            dropId,
            group_ids_user_is_eligible_for,
            ctx.connection
          )
    ).then(async (drop) => {
      if (!drop) {
        throw new NotFoundException(`Drop ${dropId} not found`);
      }

      return drop;
    });
    return this.dropsMappers
      .convertToDropFulls(
        {
          dropEntities: [dropEntity],
          authenticationContext: ctx.authenticationContext
        },
        ctx.connection
      )
      .then((it) => it[0]);
  }

  public async findLightDrops(
    {
      waveId,
      limit,
      max_serial_no,
      min_serial_no,
      older_first
    }: {
      waveId: string | null;
      limit: number;
      max_serial_no: number | null;
      min_serial_no: number | null;
      older_first: boolean;
    },
    ctx: RequestContext
  ): Promise<ApiLightDrop[]> {
    const authenticationContext = ctx.authenticationContext;
    const context_profile_id = getWaveReadContextProfileId(
      authenticationContext
    );
    const group_ids_user_is_eligible_for =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        context_profile_id
      );
    const lightDropIds = waveId
      ? await this.dropsDb.findLightDropIdsByWave(
          {
            limit,
            min_serial_no,
            max_serial_no,
            group_ids_user_is_eligible_for,
            wave_id: waveId,
            older_first
          },
          ctx
        )
      : await this.dropsDb.findVisibleLightDropIds(
          {
            limit,
            min_serial_no,
            max_serial_no,
            group_ids_user_is_eligible_for,
            older_first
          },
          ctx
        );
    const entities = await this.dropsDb.findLightDropsByIds(
      lightDropIds.map((it) => it.id),
      ctx
    );
    const apiLightDrops = Object.values(
      entities.reduce(
        (acc, it) => {
          acc[it.id] = {
            id: it.id,
            wave_id: it.wave_id,
            wave_name: it.wave_name,
            author: it.author,
            created_at: it.created_at,
            serial_no: it.serial_no,
            drop_type: enums.resolveOrThrow(
              ApiDropType,
              it.drop_type.toString()
            ),
            title: it.title,
            is_reply_drop: !!it.reply_to_drop_id,
            part_1_medias: JSON.parse(it.medias_json ?? `[]`) as ApiDropMedia[],
            part_1_text: it.part_content,
            has_quote: !!it.part_quoted_drop_id
          };
          return acc;
        },
        {} as Record<string, ApiLightDrop>
      )
    );
    return apiLightDrops.sort((a, d) => a.serial_no - d.serial_no);
  }

  public async findLatestDrops(
    {
      amount,
      group_id,
      wave_id,
      curation_id,
      curation_name,
      serial_no_less_than,
      author_id,
      include_replies,
      drop_type,
      ids,
      contains_media
    }: {
      group_id: string | null;
      serial_no_less_than: number | null;
      wave_id: string | null;
      curation_id: string | null;
      curation_name: string | null;
      amount: number;
      author_id: string | null;
      include_replies: boolean;
      drop_type: ApiDropType | null;
      ids: string[] | null;
      contains_media: boolean;
    },
    ctx: RequestContext
  ): Promise<ApiDrop[]> {
    const authenticationContext = ctx.authenticationContext;
    const context_profile_id = getWaveReadContextProfileId(
      authenticationContext
    );
    const group_ids_user_is_eligible_for =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        context_profile_id
      );
    if (group_id && !group_ids_user_is_eligible_for.includes(group_id)) {
      return [];
    }
    const normalizedCurationName =
      this.normalizeCurationNameOrThrow(curation_name);
    const { curationFilter, resolvedWaveId } = await this.resolveCurationFilter(
      {
        curationId: curation_id,
        curationName: normalizedCurationName,
        waveId: wave_id
      },
      ctx
    );
    const dropEntities = await this.dropsDb.findLatestDrops(
      {
        amount,
        serial_no_less_than,
        group_id,
        group_ids_user_is_eligible_for,
        wave_id: resolvedWaveId,
        curation_id: curationFilter,
        curation_name: normalizedCurationName,
        author_id,
        include_replies,
        drop_type: drop_type ? enums.resolveOrThrow(DropType, drop_type) : null,
        ids,
        contains_media
      },
      ctx
    );
    return await this.dropsMappers.convertToDropFulls(
      {
        dropEntities: dropEntities,
        authenticationContext
      },
      ctx.connection
    );
  }

  public async findDropIdsInWaveRange(
    {
      wave_id,
      min_serial_no,
      max_serial_no,
      limit
    }: {
      wave_id: string;
      min_serial_no: number;
      max_serial_no: number | null;
      limit: number;
    },
    ctx: RequestContext
  ): Promise<ApiDropId[]> {
    const authenticationContext = ctx.authenticationContext;
    const context_profile_id = getWaveReadContextProfileId(
      authenticationContext
    );
    const group_ids_user_is_eligible_for =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        context_profile_id
      );
    const maxSerialNo = max_serial_no ?? Number.MAX_SAFE_INTEGER;
    return this.dropsDb.findDropIdsInWaveRange(
      {
        wave_id,
        min_serial_no,
        max_serial_no: maxSerialNo,
        limit,
        group_ids_user_is_eligible_for
      },
      ctx
    );
  }

  async findDropsByIdsOrThrow(
    dropIds: string[],
    authenticationContext: AuthenticationContext | undefined,
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, ApiDrop>> {
    const result = await this.findDropsByIds(
      dropIds,
      authenticationContext,
      connection
    );
    const dropFulls = Object.values(result);
    const missingDrops = dropIds.filter(
      (it) => !dropFulls.find((e) => e.id === it)
    );
    if (missingDrops.length) {
      throw new NotFoundException(
        `Drop(s) not found: ${missingDrops.join(', ')}`
      );
    }
    return result;
  }

  public async findDropsByIds(
    dropIds: string[],
    authenticationContext: AuthenticationContext | undefined,
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, ApiDrop>> {
    const dropEntities = await this.dropsDb.getDropsByIds(dropIds, connection);
    return await this.dropsMappers
      .convertToDropFulls(
        {
          dropEntities,
          authenticationContext
        },
        connection
      )
      .then((drops) =>
        drops.reduce(
          (acc, drop) => {
            acc[drop.id] = drop;
            return acc;
          },
          {} as Record<string, ApiDrop>
        )
      );
  }

  async addDropSubscriptionActions({
    subscriber,
    dropId,
    actions,
    authenticationContext
  }: {
    subscriber: string;
    dropId: string;
    actions: ApiDropSubscriptionTargetAction[];
    authenticationContext: AuthenticationContext;
  }): Promise<ApiDropSubscriptionTargetAction[]> {
    const waveId = await this.findDropByIdOrThrow(
      {
        dropId
      },
      { authenticationContext }
    ).then((it) => it.wave.id);
    const proposedActions = Object.values(actions).map((it) =>
      enums.resolveOrThrow(ActivityEventAction, it)
    );
    return await this.identitySubscriptionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const existingActions =
          await this.identitySubscriptionsDb.findIdentitySubscriptionActionsOfTarget(
            {
              subscriber_id: subscriber,
              target_id: dropId,
              target_type: ActivityEventTargetType.DROP
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
              target_id: dropId,
              target_type: ActivityEventTargetType.DROP,
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
              target_id: dropId,
              target_type: ActivityEventTargetType.DROP
            },
            connection
          )
          .then((result) =>
            result.map((it) =>
              enums.resolveOrThrow(ApiDropSubscriptionTargetAction, it)
            )
          );
      }
    );
  }

  async removeDropSubscriptionActions({
    subscriber,
    dropId,
    authenticationContext,
    actions
  }: {
    subscriber: string;
    dropId: string;
    authenticationContext: AuthenticationContext;
    actions: ApiDropSubscriptionTargetAction[];
  }): Promise<ApiDropSubscriptionTargetAction[]> {
    await this.findDropByIdOrThrow(
      {
        dropId
      },
      { authenticationContext }
    );
    return this.identitySubscriptionsDb.executeNativeQueriesInTransaction(
      async (connection) => {
        for (const action of actions) {
          await this.identitySubscriptionsDb.deleteIdentitySubscription(
            {
              subscriber_id: subscriber,
              target_id: dropId,
              target_type: ActivityEventTargetType.DROP,
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
              target_id: dropId,
              target_type: ActivityEventTargetType.DROP
            },
            connection
          )
          .then((result) =>
            result.map((it) =>
              enums.resolveOrThrow(ApiDropSubscriptionTargetAction, it)
            )
          );
      }
    );
  }

  public async findWaveDropsFeed(
    {
      drop_id,
      wave_id,
      serial_no_limit,
      amount,
      search_strategy,
      drop_type,
      curation_id
    }: {
      drop_id: string | null;
      serial_no_limit: number | null;
      wave_id: string;
      amount: number;
      search_strategy: ApiDropSearchStrategy;
      drop_type: ApiDropType | null;
      curation_id: string | null;
    },
    ctx: RequestContext
  ): Promise<ApiWaveDropsFeed> {
    ctx.timer?.start('dropsApiService->findWaveDropsFeed');
    const authenticationContext = ctx.authenticationContext!;
    const context_profile_id = getWaveReadContextProfileId(
      authenticationContext
    );
    const { noRightToVote, noRightToParticipate } = getWaveMinPermissionMask(
      authenticationContext
    );
    const group_ids_user_is_eligible_for =
      !authenticationContext.isUserFullyAuthenticated() ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.hasProxyAction(ProfileProxyActionType.READ_WAVE))
        ? []
        : await this.userGroupsService.getGroupsUserIsEligibleFor(
            context_profile_id
          );
    const { curationFilter } = await this.resolveCurationFilter(
      {
        curationId: curation_id,
        waveId: wave_id
      },
      ctx
    );
    const [wave, waveVotingCreditNftsByWaveId, pinnedWaveIds, identityWaveIds] =
      await Promise.all([
        wavesApiDb.findWaveById(wave_id),
        wavesApiDb.findWaveVotingCreditNftsByWaveIds([wave_id]),
        wavesApiDb.whichOfWavesArePinnedByGivenProfile(
          {
            waveIds: [wave_id],
            profileId: context_profile_id
          },
          ctx
        ),
        profileWavesDb.findSelectedWaveIdsByWaveIds([wave_id], ctx)
      ]);
    if (
      !wave ||
      (wave.visibility_group_id &&
        !group_ids_user_is_eligible_for.includes(wave.visibility_group_id))
    ) {
      throw new NotFoundException(`Wave ${wave_id} not found`);
    }
    const displayByWaveId =
      await directMessageWaveDisplayService.resolveWaveDisplayByWaveIdForContext(
        {
          waveEntities: [wave],
          contextProfileId: context_profile_id
        },
        ctx.connection
      );
    const waveMin = mapWaveToApiWaveMin({
      wave: {
        ...wave,
        voting_credit_nfts: waveVotingCreditNftsByWaveId[wave.id] ?? null
      },
      displayByWaveId,
      groupIdsUserIsEligibleFor: group_ids_user_is_eligible_for,
      noRightToVote,
      noRightToParticipate,
      pinned: pinnedWaveIds.has(wave_id),
      identityWave: identityWaveIds.has(wave_id),
      authenticatedProfileId: context_profile_id
    });
    if (drop_id) {
      const dropEntity = await this.dropsDb.findDropByIdWithEligibilityCheck(
        drop_id,
        group_ids_user_is_eligible_for,
        ctx.connection
      );
      if (!dropEntity || dropEntity.wave_id !== wave_id) {
        throw new NotFoundException(`Drop ${drop_id} not found`);
      }
      const trace = await this.dropsDb.getTraceForDrop(drop_id, ctx);
      const dropEntities = await this.dropsDb.findLatestDropRepliesSimple(
        {
          drop_id: drop_id,
          amount,
          serial_no_limit,
          search_strategy,
          curation_id: curationFilter,
          drop_type: drop_type
            ? enums.resolveOrThrow(DropType, drop_type)
            : null
        },
        ctx
      );
      const drops = await this.dropsMappers.convertToDropsWithoutWaves(
        dropEntities,
        ctx
      );
      const rootDrop = await this.dropsMappers
        .convertToDropsWithoutWaves([dropEntity], ctx)
        .then((it) => it[0]!);
      const resp: ApiWaveDropsFeed = {
        drops,
        wave: waveMin,
        trace: trace.map<ApiDropTraceItem>((it) => ({
          drop_id: it.drop_id,
          is_deleted: it.is_deleted
        })),
        root_drop: rootDrop
      };
      ctx.timer?.stop('dropsApiService->findWaveDropsFeed');
      return resp;
    } else {
      const dropEntities = await this.dropsDb.findLatestDropsSimple(
        {
          wave_id: wave.id,
          amount,
          serial_no_limit,
          search_strategy,
          curation_id: curationFilter,
          drop_type: drop_type
            ? enums.resolveOrThrow(DropType, drop_type)
            : null
        },
        ctx
      );
      const drops = await this.dropsMappers.convertToDropsWithoutWaves(
        dropEntities,
        ctx
      );
      const resp: ApiWaveDropsFeed = {
        drops,
        wave: waveMin
      };
      ctx.timer?.stop('dropsApiService->findWaveDropsFeed');
      return resp;
    }
  }

  public async findWaveCurationDrops(
    {
      wave_id,
      curation_id,
      page,
      page_size
    }: {
      wave_id: string;
      curation_id: string;
      page: number;
      page_size: number;
    },
    ctx: RequestContext
  ): Promise<ApiCurationDropsPage> {
    if (!(page >= 1) || !(page_size > 0)) {
      throw new BadRequestException(
        `Curation drops pagination requires page >= 1 and page_size > 0`
      );
    }
    const { curationFilter } = await this.resolveCurationFilter(
      {
        curationId: curation_id,
        waveId: wave_id
      },
      ctx
    );
    if (!curationFilter) {
      throw new NotFoundException(`Curation ${curation_id} not found`);
    }
    const entities = await this.dropsDb.findDropsByCurationPriorityOrder(
      {
        wave_id,
        curation_id: curationFilter,
        limit: page_size + 1,
        offset: page_size * (page - 1)
      },
      ctx
    );
    const pageEntities = entities.slice(0, page_size);
    const priorityOrderByDropId = new Map<string, number | null>(
      pageEntities.map((it) => [it.id, it.drop_priority_order])
    );
    const drops = await this.dropsMappers.convertToDropsWithoutWaves(
      pageEntities,
      ctx
    );
    const data = drops.map((drop) => ({
      ...drop,
      drop_priority_order: priorityOrderByDropId.get(drop.id) ?? null
    })) as ApiCurationDrop[];
    return {
      data,
      page,
      next: entities.length > page_size
    };
  }

  private normalizeCurationNameOrThrow(
    curationName: string | null
  ): string | null {
    const normalized = curationName?.trim() ?? null;
    if (!normalized) {
      return null;
    }
    if (normalized.length > 50) {
      throw new BadRequestException(`Curation name must be 1-50 chars`);
    }
    return normalized;
  }

  private async resolveCurationFilter(
    {
      curationId,
      curationName,
      waveId
    }: {
      curationId: string | null;
      curationName?: string | null;
      waveId?: string | null;
    },
    ctx: RequestContext
  ): Promise<{
    curationFilter: string | null;
    resolvedWaveId: string | null;
  }> {
    if (curationId && curationName) {
      throw new BadRequestException(
        `Use either curation_id or curation_name, not both`
      );
    }
    if (!curationId) {
      return {
        curationFilter: null,
        resolvedWaveId: waveId ?? null
      };
    }
    const curation = await this.curationsDb.findWaveCurationById(
      { id: curationId },
      ctx.connection
    );
    if (!curation || (waveId && curation.wave_id !== waveId)) {
      throw new NotFoundException(`Curation ${curationId} not found`);
    }
    const groupsUserIsEligibleFor = await getGroupsUserIsEligibleForReadContext(
      this.userGroupsService,
      ctx
    );
    const resolvedWaveId = waveId ?? curation.wave_id;
    const wave = await wavesApiDb.findWaveById(resolvedWaveId, ctx.connection);
    assertWaveVisibleOrThrow(
      wave,
      groupsUserIsEligibleFor,
      `Curation ${curationId} not found`
    );
    return {
      curationFilter: curation.id,
      resolvedWaveId
    };
  }

  async findLeaderboard(
    params: LeaderboardParams,
    ctx: RequestContext
  ): Promise<ApiDropsLeaderboardPage> {
    const authContext = ctx.authenticationContext!;
    const { noRightToVote, noRightToParticipate } =
      getWaveMinPermissionMask(authContext);
    let authenticatedProfileId: string | null = null;
    if (authContext) {
      if (authContext.isUserFullyAuthenticated()) {
        if (
          !authContext.isAuthenticatedAsProxy() ||
          authContext.hasProxyAction(ProfileProxyActionType.READ_WAVE)
        ) {
          authenticatedProfileId = authContext.getActingAsId();
        }
      }
    }
    if (
      authContext.isAuthenticatedAsProxy() &&
      !authContext.hasProxyAction(ProfileProxyActionType.READ_WAVE)
    ) {
      throw new ForbiddenException(
        `User is authenticated as proxy but doesn't have persmission to read waves`
      );
    }
    if (params.unvoted_by_me && authenticatedProfileId === null) {
      throw new BadRequestException(
        `User must be authenticated to use unvoted_by_me`
      );
    }
    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(
        authenticatedProfileId
      );
    const { curationFilter } = await this.resolveCurationFilter(
      {
        curationId: params.curation_id,
        waveId: params.wave_id
      },
      ctx
    );
    const [
      waveEntity,
      waveVotingCreditNftsByWaveId,
      pinnedWaveIds,
      identityWaveIds
    ] = await Promise.all([
      wavesApiDb.findWaveById(params.wave_id),
      wavesApiDb.findWaveVotingCreditNftsByWaveIds([params.wave_id]),
      wavesApiDb.whichOfWavesArePinnedByGivenProfile(
        {
          waveIds: [params.wave_id],
          profileId: authenticatedProfileId
        },
        ctx
      ),
      profileWavesDb.findSelectedWaveIdsByWaveIds([params.wave_id], ctx)
    ]);
    if (
      !waveEntity ||
      (waveEntity.visibility_group_id !== null &&
        !groupIdsUserIsEligibleFor.includes(waveEntity.visibility_group_id))
    ) {
      throw new ForbiddenException(`Wave ${params.wave_id} not found`);
    }
    if (waveEntity.type === WaveType.CHAT) {
      throw new BadRequestException(`CHAT waves don't have a leaderboard`);
    }
    const displayByWaveId =
      await directMessageWaveDisplayService.resolveWaveDisplayByWaveIdForContext(
        {
          waveEntities: [waveEntity],
          contextProfileId: authenticatedProfileId
        },
        ctx.connection
      );
    const votingPeriodEnd = waveEntity.voting_period_end;
    const waveMin = mapWaveToApiWaveMin({
      wave: {
        ...waveEntity,
        voting_credit_nfts: waveVotingCreditNftsByWaveId[waveEntity.id] ?? null,
        voting_period_end: votingPeriodEnd
      },
      displayByWaveId,
      groupIdsUserIsEligibleFor,
      noRightToVote,
      noRightToParticipate,
      pinned: pinnedWaveIds.has(params.wave_id),
      identityWave: identityWaveIds.has(params.wave_id),
      authenticatedProfileId
    });
    const isTimeLockedWave =
      waveEntity.time_lock_ms !== null && waveEntity.time_lock_ms > 0;
    const resolvedParams: LeaderboardParams = {
      ...params,
      curation_id: curationFilter
    };
    const count = await this.dropsDb.countParticipatoryDrops(
      resolvedParams,
      ctx,
      authenticatedProfileId
    );
    const drops = await this.findLeaderboardDrops(
      resolvedParams,
      isTimeLockedWave,
      ctx,
      authenticatedProfileId
    ).then(async (drops) => {
      ctx.timer?.start(`${this.constructor.name}->convertLeaderboardDrops`);
      const results = await this.dropsMappers.convertToDropsWithoutWaves(
        drops,
        ctx
      );
      ctx.timer?.stop(`${this.constructor.name}->convertLeaderboardDrops`);
      return results;
    });
    return {
      wave: waveMin,
      drops: drops,
      count: count,
      page: params.page,
      next: count > params.page_size * params.page
    };
  }

  private async findLeaderboardDrops(
    params: LeaderboardParams,
    isTimeLockedWave: boolean,
    ctx: RequestContext,
    authenticatedProfileId: string | null
  ): Promise<DropEntity[]> {
    if (params.sort === LeaderboardSort.PRICE) {
      return this.dropsDb.findWaveParticipationDropsOrderedByNftPrice(
        {
          wave_id: params.wave_id,
          limit: params.page_size,
          offset: (params.page - 1) * params.page_size,
          sort_order: params.sort_direction,
          curation_id: params.curation_id,
          unvoted_by_me: params.unvoted_by_me,
          voter_id: authenticatedProfileId,
          price_currency: params.price_currency,
          min_price: params.min_price,
          max_price: params.max_price
        },
        ctx
      );
    }
    if (params.sort === LeaderboardSort.CREATED_AT) {
      return this.dropsDb.findWaveParticipationDropsOrderedByCreatedAt(
        {
          wave_id: params.wave_id,
          limit: params.page_size,
          offset: (params.page - 1) * params.page_size,
          sort_order: params.sort_direction,
          curation_id: params.curation_id,
          unvoted_by_me: params.unvoted_by_me,
          voter_id: authenticatedProfileId,
          price_currency: params.price_currency,
          min_price: params.min_price,
          max_price: params.max_price
        },
        ctx
      );
    }
    if (isTimeLockedWave) {
      if (params.sort === LeaderboardSort.RANK) {
        return this.dropsDb.findWeightedLeaderboardDrops(
          params,
          ctx,
          authenticatedProfileId
        );
      } else if (params.sort === LeaderboardSort.RATING_PREDICTION) {
        return this.dropsDb.findWeightedLeaderboardDropsOrderedByPrediction(
          params,
          ctx,
          authenticatedProfileId
        );
      } else if (params.sort === LeaderboardSort.TREND) {
        return this.dropsDb.findWeightedLeaderboardDropsOrderedByTrend(
          params,
          ctx,
          authenticatedProfileId
        );
      }
    }
    if (params.sort === LeaderboardSort.MY_REALTIME_VOTE) {
      const voterId = authenticatedProfileId;
      if (!voterId) {
        throw new BadRequestException(
          `Can't sort by voter votes as the user is not authenticated`
        );
      }
      return this.dropsDb.findRealtimeLeaderboardDropsOrderedByUsersVotesOrCreationTime(
        {
          voter_id: voterId,
          wave_id: params.wave_id,
          limit: params.page_size,
          offset: (params.page - 1) * params.page_size,
          sort_order: params.sort_direction,
          curation_id: params.curation_id,
          unvoted_by_me: params.unvoted_by_me,
          price_currency: params.price_currency,
          min_price: params.min_price,
          max_price: params.max_price
        },
        ctx
      );
    }
    return this.dropsDb.findRealtimeLeaderboardDrops(
      {
        wave_id: params.wave_id,
        limit: params.page_size,
        offset: (params.page - 1) * params.page_size,
        sort_order: params.sort_direction,
        curation_id: params.curation_id,
        unvoted_by_me: params.unvoted_by_me,
        voter_id: authenticatedProfileId,
        price_currency: params.price_currency,
        min_price: params.min_price,
        max_price: params.max_price
      },
      ctx
    );
  }

  async findWaveLogs(
    param: DropLogsQueryParams,
    ctx: RequestContext
  ): Promise<ApiWaveLog[]> {
    await this.assertViewingEligibilityForWave(param.wave_id, ctx);
    const logEntities = await this.dropsDb.findDropLogEntities(param, ctx);
    const relatedProfiles = await this.findDropLogRelatedProfiles(
      logEntities,
      ctx
    );
    return logEntities.map<ApiWaveLog>((it) => ({
      id: it.id,
      action: it.type,
      wave_id: it.additional_data_2!,
      drop_id: it.target_id!,
      drop_author: it.additional_data_1
        ? relatedProfiles[it.additional_data_1]
        : undefined,
      invoker_proxy: it.proxy_id ? relatedProfiles[it.proxy_id] : undefined,
      invoker: relatedProfiles[it.profile_id],
      created_at: it.created_at,
      contents: JSON.parse(it.contents)
    }));
  }

  private async assertViewingEligibilityForWave(
    waveId: string,
    ctx: RequestContext
  ) {
    const waveEntity = await wavesApiDb.findWaveById(waveId);
    if (!waveEntity) {
      throw new NotFoundException(`Wave not found`);
    }
    const visibilityGroupId = waveEntity.visibility_group_id;
    if (visibilityGroupId !== null) {
      const authContext = ctx.authenticationContext;
      if (authContext?.hasRightsTo(ProfileProxyActionType.READ_WAVE)) {
        const eligibleGroups =
          await this.userGroupsService.getGroupsUserIsEligibleFor(
            authContext?.getActingAsId(),
            ctx.timer
          );
        if (!eligibleGroups.includes(visibilityGroupId)) {
          throw new NotFoundException(`Wave not found`);
        }
      }
    }
  }

  private findDropLogRelatedProfiles(
    logEntities: ProfileActivityLog[],
    ctx: RequestContext
  ): Promise<Record<string, ApiProfileMin>> {
    const relatedProfileIds = logEntities
      .map((it) => {
        const ids = [it.profile_id];
        if (it.proxy_id) {
          ids.push(it.proxy_id);
        }
        if (
          [
            ProfileActivityLogType.DROP_CLAPPED,
            ProfileActivityLogType.DROP_VOTE_EDIT
          ].includes(it.type)
        ) {
          ids.push(it.additional_data_1!);
        }
        return ids;
      })
      .flat();
    return this.identityFetcher.getOverviewsByIds(relatedProfileIds, ctx);
  }

  async findVotersInfo(
    params: DropVotersStatsParams,
    ctx: RequestContext
  ): Promise<ApiWaveVotersPage> {
    await this.assertViewingEligibilityForWave(params.wave_id, ctx);

    const dropId = params.drop_id;
    if (dropId) {
      const drop = await this.dropsDb.findDropById(dropId, ctx.connection);
      if (
        drop?.wave_id === params.wave_id &&
        drop?.drop_type === DropType.WINNER
      ) {
        const [data, totalCount] = await Promise.all([
          this.dropsDb.getWinnerDropVoters(
            {
              drop_id: dropId,
              page: params.page,
              page_size: params.page_size,
              direction: params.sort_direction
            },
            ctx
          ),
          this.dropsDb.countWinnerDropVoters(dropId, ctx)
        ]);
        const voters = await this.identityFetcher.getOverviewsByIds(
          data.map((it) => it.voter_id),
          ctx
        );
        return {
          page: params.page,
          count: totalCount,
          next: totalCount > params.page_size * params.page,
          data: data.map<ApiWaveVoter>((it) => ({
            voter: voters[it.voter_id],
            votes_summed: it.votes,
            positive_votes_summed: it.votes > 0 ? it.votes : 0,
            negative_votes_summed: it.votes < 0 ? it.votes : 0,
            absolute_votes_summed: Math.abs(it.votes),
            min_vote: it.votes,
            max_vote: it.votes,
            different_drops_voted: 1,
            average_vote: it.votes
          }))
        };
      }
    }

    const [data, totalCount] = await Promise.all([
      this.dropsDb.findVotersInfo(params, ctx),
      this.dropsDb.countVoters(params, ctx)
    ]);
    const voters = await this.identityFetcher.getOverviewsByIds(
      data.map((it) => it.voter_id),
      ctx
    );
    return {
      page: params.page,
      count: totalCount,
      next: totalCount > params.page_size * params.page,
      data: data.map<ApiWaveVoter>((it) => ({
        voter: voters[it.voter_id],
        votes_summed: it.votes_summed,
        positive_votes_summed: it.positive_votes_summed,
        negative_votes_summed: it.negative_votes_summed,
        absolute_votes_summed: it.absolute_votes_summed,
        min_vote: it.min_vote,
        max_vote: it.max_vote,
        different_drops_voted: it.different_drops_voted,
        average_vote: it.average_vote
      }))
    };
  }

  async searchDropsContainingPhraseInWave(
    {
      wave_id,
      term,
      size,
      page
    }: { term: string; page: number; size: number; wave_id: string },
    ctx: RequestContext
  ): Promise<ApiDropWithoutWavesPageWithoutCount> {
    const wave = await this.dropsDb.findWaveByIdOrNull(wave_id, ctx.connection);
    if (!wave) {
      throw new NotFoundException(`Wave ${wave_id} not found`);
    }
    const contextProfileId = getWaveReadContextProfileId(
      ctx.authenticationContext
    );
    const visibilityGroupId = wave.visibility_group_id;
    if (visibilityGroupId) {
      const group_ids_user_is_eligible_for =
        await this.userGroupsService.getGroupsUserIsEligibleFor(
          contextProfileId
        );
      if (!group_ids_user_is_eligible_for.includes(visibilityGroupId)) {
        throw new NotFoundException(`Wave ${wave_id} not found`);
      }
    }
    const offset = size * (page - 1);
    const entities = await this.dropsDb.searchDropsContainingPhraseInWave(
      { wave_id, term, limit: size + 1, offset },
      ctx
    );
    const converted = await this.dropsMappers.convertToDropsWithoutWaves(
      entities.slice(0, size),
      ctx
    );
    return {
      data: converted,
      next: entities.length > size,
      page: page
    };
  }

  async findPageOfDropBoosts(
    searchRequest: GetDropsBoostsRequest,
    ctx: RequestContext
  ): Promise<ApiDropBoostsPage> {
    try {
      ctx.timer?.start(`${this.constructor.name}->findPageOfDropBoosts`);
      await this.findDropByIdOrThrow({ dropId: searchRequest.drop_id }, ctx);
      const offset = searchRequest.page_size * (searchRequest.page - 1);
      const [data, count] = await Promise.all([
        this.dropsDb.getDropBoosts(
          {
            drop_id: searchRequest.drop_id,
            limit: searchRequest.page_size,
            offset,
            order_by: searchRequest.sort,
            order: searchRequest.sort_direction
          },
          ctx
        ),
        this.dropsDb.countDropBoosts({ drop_id: searchRequest.drop_id }, ctx)
      ]);
      const boostersProfiles = await this.identityFetcher.getOverviewsByIds(
        data.map((it) => it.booster_id),
        ctx
      );
      return {
        data: data.map((it) => ({
          booster: boostersProfiles[it.booster_id],
          boosted_at: it.boosted_at
        })),
        count,
        page: searchRequest.page,
        next: count > searchRequest.page_size * searchRequest.page
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findPageOfDropBoosts`);
    }
  }

  async boostDrop(dropId: string, ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->boostDrop`);
      const boosterId = ctx.authenticationContext?.getActingAsId();
      if (!boosterId) {
        throw new ForbiddenException(
          `Can't boost a drop without logging in and creating a profile`
        );
      }
      const apiDrop = await this.findDropByIdOrThrow({ dropId }, ctx);
      const updatedDrop = await this.dropsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          await this.dropsDb.boostDrop(
            {
              drop_id: dropId,
              booster_id: boosterId,
              wave_id: apiDrop.wave.id
            },
            { ...ctx, connection }
          );
          await userNotifier.notifyOfDropBoost(
            {
              booster_id: boosterId,
              drop_id: dropId,
              drop_author_id: apiDrop.author.id,
              wave_id: apiDrop.wave.id
            },
            apiDrop.wave.visibility_group_id,
            connection
          );
          await this.metricsRecorder.recordActiveIdentity(
            { identityId: boosterId },
            { ...ctx, connection }
          );
          return await this.findDropByIdOrThrow(
            { dropId, skipEligibilityCheck: true },
            ctx
          );
        }
      );
      await giveReadReplicaTimeToCatchUp();

      await this.wsListenersNotifier.notifyAboutDropUpdate(updatedDrop, ctx);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->boostDrop`);
    }
  }

  async deleteDropBoost(dropId: string, ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->deleteDropBoost`);
      const boosterId = ctx.authenticationContext?.getActingAsId();
      if (!boosterId) {
        throw new ForbiddenException(
          `Can't delete a boost from drop without logging in and creating a profile`
        );
      }
      await this.findDropByIdOrThrow({ dropId }, ctx);
      const updatedDrop = await this.dropsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          await this.dropsDb.deleteDropBoost(
            { drop_id: dropId, booster_id: boosterId },
            { ...ctx, connection }
          );
          await this.metricsRecorder.recordActiveIdentity(
            { identityId: boosterId },
            { ...ctx, connection }
          );
          return await this.findDropByIdOrThrow(
            { dropId, skipEligibilityCheck: true },
            ctx
          );
        }
      );
      await giveReadReplicaTimeToCatchUp();
      await this.wsListenersNotifier.notifyAboutDropUpdate(updatedDrop, ctx);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteDropBoost`);
    }
  }

  async findBoostedDrops(
    req: FindBoostedDropsRequest,
    ctx: RequestContext
  ): Promise<ApiDropsPage> {
    try {
      ctx.timer?.start(`${this.constructor.name}->findBoostedDrops`);
      const contextProfileId = getWaveReadContextProfileId(
        ctx.authenticationContext
      );
      const group_ids_user_is_eligible_for =
        await this.userGroupsService.getGroupsUserIsEligibleFor(
          contextProfileId
        );
      const boosterId =
        req.booster === null
          ? null
          : await this.identityFetcher.getProfileIdByIdentityKeyOrThrow(
              { identityKey: req.booster },
              ctx
            );
      const authorId =
        req.author === null
          ? null
          : await this.identityFetcher.getProfileIdByIdentityKeyOrThrow(
              { identityKey: req.author },
              ctx
            );
      const offset = req.page_size * (req.page - 1);
      const [data, count] = await Promise.all([
        this.dropsDb.findBoostedDrops(
          {
            wave_id: req.wave_id,
            eligibile_groups: group_ids_user_is_eligible_for,
            limit: req.page_size,
            offset,
            booster_id: boosterId,
            author_id: authorId,
            order_by: req.sort,
            order: req.sort_direction,
            min_boosts: req.min_boosts,
            count_only_boosts_after: req.count_only_boosts_after
          },
          ctx
        ),
        this.dropsDb.countBoostedDrops(
          {
            wave_id: req.wave_id,
            eligibile_groups: group_ids_user_is_eligible_for,
            booster_id: boosterId,
            author_id: authorId,
            min_boosts: req.min_boosts,
            count_only_boosts_after: req.count_only_boosts_after
          },
          ctx
        )
      ]);
      const apiDrops = await this.dropsMappers.convertToDropFulls(
        {
          dropEntities: data,
          authenticationContext: ctx.authenticationContext
        },
        ctx.connection
      );
      return {
        data: apiDrops,
        count,
        page: req.page,
        next: count > req.page_size * req.page
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findBoostedDrops`);
    }
  }
}

export interface GetDropsBoostsRequest {
  drop_id: string;
  page_size: number;
  page: number;
  sort_direction: ApiPageSortDirection;
  sort: 'boosted_at';
}

export interface FindBoostedDropsRequest {
  author: string | null;
  booster: string | null;
  wave_id: string | null;
  min_boosts: number | null;
  count_only_boosts_after: number;
  page_size: number;
  page: number;
  sort_direction: ApiPageSortDirection;
  sort: 'last_boosted_at' | 'first_boosted_at' | 'drop_created_at' | 'boosts';
}

export const dropsService = new DropsApiService(
  dropsMappers,
  dropsDb,
  curationsDb,
  userGroupsService,
  identitySubscriptionsDb,
  identityFetcher,
  metricsRecorder,
  wsListenersNotifier
);
