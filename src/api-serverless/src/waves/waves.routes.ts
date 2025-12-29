import { asyncRouter } from '../async.router';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { ApiWave } from '../generated/models/ApiWave';
import { ApiCreateNewWave } from '../generated/models/ApiCreateNewWave';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../../../exceptions';
import * as Joi from 'joi';
import { ApiCreateNewWaveScope } from '../generated/models/ApiCreateNewWaveScope';
import { ApiCreateNewWaveVisibilityConfig } from '../generated/models/ApiCreateNewWaveVisibilityConfig';
import { ApiCreateNewWaveVotingConfig } from '../generated/models/ApiCreateNewWaveVotingConfig';
import { ApiWaveCreditType } from '../generated/models/ApiWaveCreditType';
import { ApiWaveCreditScope } from '../generated/models/ApiWaveCreditScope';
import { ApiIntRange } from '../generated/models/ApiIntRange';
import { ApiCreateNewWaveParticipationConfig } from '../generated/models/ApiCreateNewWaveParticipationConfig';
import { ApiWaveRequiredMetadata } from '../generated/models/ApiWaveRequiredMetadata';
import { ApiWaveConfig } from '../generated/models/ApiWaveConfig';
import { ApiWaveType } from '../generated/models/ApiWaveType';
import { getValidatedByJoiOrThrow } from '../validation';
import { waveApiService } from './wave.api.service';
import { SearchWavesParams } from './waves.api.db';
import { ProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import { userGroupsService } from '../community-members/user-groups.service';
import { NewWaveDropSchema } from '../drops/drop.validator';
import { ApiWaveParticipationRequirement } from '../generated/models/ApiWaveParticipationRequirement';
import { ApiWaveOutcomeType } from '../generated/models/ApiWaveOutcomeType';
import { ApiWaveOutcomeSubType } from '../generated/models/ApiWaveOutcomeSubType';
import { ApiWaveOutcomeCredit } from '../generated/models/ApiWaveOutcomeCredit';
import { REP_CATEGORY_PATTERN } from '../../../entities/IAbusivenessDetectionResult';
import { ApiWaveSubscriptionActions } from '../generated/models/ApiWaveSubscriptionActions';
import { ApiWaveSubscriptionTargetAction } from '../generated/models/ApiWaveSubscriptionTargetAction';
import { Time, Timer } from '../../../time';
import { RequestContext } from '../../../request.context';
import { ApiUpdateWaveRequest } from '../generated/models/ApiUpdateWaveRequest';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { dropsService } from '../drops/drops.api.service';
import { ApiWaveDropsFeed } from '../generated/models/ApiWaveDropsFeed';
import { ApiDropSearchStrategy } from '../generated/models/ApiDropSearchStrategy';
import { ApiDropType } from '../generated/models/ApiDropType';
import { ApiCreateNewWaveChatConfig } from '../generated/models/ApiCreateNewWaveChatConfig';
import { PageSortDirection } from '../page-request';
import { ApiDropsLeaderboardPage } from '../generated/models/ApiDropsLeaderboardPage';
import {
  DropLogsQueryParams,
  DropVotersStatsParams,
  DropVotersStatsSort,
  LeaderboardParams,
  LeaderboardSort
} from '../../../drops/drops.db';
import { DROP_LOG_TYPES } from '../../../entities/IProfileActivityLog';
import { ApiWaveLog } from '../generated/models/ApiWaveLog';
import { ApiWaveVotersPage } from '../generated/models/ApiWaveVotersPage';
import { ApiWaveOutcomeDistributionItem } from '../generated/models/ApiWaveOutcomeDistributionItem';
import { ApiWaveDecisionsStrategy } from '../generated/models/ApiWaveDecisionsStrategy';
import { ApiWaveDecisionsPage } from '../generated/models/ApiWaveDecisionsPage';
import {
  waveDecisionsApiService,
  WaveDecisionsQuery,
  WaveDecisionsQuerySort,
  WaveOutcomeDistributionQuery,
  WaveOutcomesQuery
} from './wave-decisions-api.service';
import { identityFetcher } from '../identities/identity.fetcher';
import { enums } from '../../../enums';
import { numbers } from '../../../numbers';
import { ApiUpdateWaveDecisionPause } from '../generated/models/ApiUpdateWaveDecisionPause';
import { clearWaveGroupsCache } from '../../../redis';
import { ApiDropWithoutWavesPageWithoutCount } from '../generated/models/ApiDropWithoutWavesPageWithoutCount';
import { ApiWaveOutcomesPage } from '../generated/models/ApiWaveOutcomesPage';
import { ApiWaveOutcomeDistributionItemsPage } from '../generated/models/ApiWaveOutcomeDistributionItemsPage';
import { ApiCreateWaveOutcome } from '../generated/models/ApiCreateWaveOutcome';

const router = asyncRouter();

router.post(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiCreateNewWave, any, any>,
    res: Response<ApiResponse<ApiWave>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const requestContext: RequestContext = { authenticationContext, timer };
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ProfileProxyActionType.CREATE_WAVE
      ]
    ) {
      throw new ForbiddenException(`Proxy is not allowed to create waves`);
    }
    let request = getValidatedByJoiOrThrow(req.body, WaveSchema);
    // Temporary hack to make sure old FE's work with new API's
    if (
      request.chat.scope.group_id === null &&
      request.participation.scope.group_id !== null &&
      request.wave.type === ApiWaveType.Chat
    ) {
      request = {
        ...request,
        chat: {
          scope: { group_id: request.participation.scope.group_id },
          enabled: request.chat.enabled
        }
      };
    }
    const wave = await waveApiService.createWave(
      request,
      false,
      requestContext
    );
    res.send(wave);
  }
);

router.post(
  '/direct-message/new',
  needsAuthenticatedUser(),
  async (
    req: Request<
      any,
      any,
      {
        identity_addresses: string[];
      },
      any,
      any
    >,
    res: Response<ApiResponse<ApiWave>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const requestContext: RequestContext = { authenticationContext, timer };
    const authenticatedProfileId = authenticationContext.getActingAsId();

    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const creatorProfile =
      await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        {
          identityKey: authenticatedProfileId
        },
        { timer, authenticationContext }
      );
    if (!creatorProfile) {
      throw new NotFoundException(`Profile not found`);
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ProfileProxyActionType.CREATE_WAVE
      ]
    ) {
      throw new ForbiddenException(`Proxy is not allowed to create waves`);
    }
    const request = getValidatedByJoiOrThrow(
      req.body,
      Joi.object<{
        identity_addresses: string[];
      }>({
        identity_addresses: Joi.array().items(Joi.string()).min(1).required()
      })
    );
    if (request.identity_addresses.includes(authenticatedProfileId)) {
      throw new BadRequestException(`You cannot DM yourself.`);
    }

    const userGroup = await userGroupsService.findOrCreateDirectMessageGroup(
      creatorProfile,
      request.identity_addresses,
      requestContext
    );

    const waveResponse = await waveApiService.findOrCreateDirectMessageWave(
      userGroup,
      requestContext
    );
    res.send(waveResponse);
  }
);

router.post(
  '/:id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, ApiUpdateWaveRequest, any, any>,
    res: Response<ApiResponse<ApiWave>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const requestContext: RequestContext = { authenticationContext, timer };
    let request = getValidatedByJoiOrThrow(req.body, UpdateWaveSchema);
    // Temporary hack to make sure old FE's work with new API's
    if (
      request.chat.scope.group_id === null &&
      request.participation.scope.group_id !== null &&
      request.wave.type === ApiWaveType.Chat
    ) {
      request = {
        ...request,
        chat: {
          scope: { group_id: request.participation.scope.group_id },
          enabled: request.chat.enabled
        }
      };
    }
    const wave = await waveApiService.updateWave(
      req.params.id,
      request,
      requestContext
    );
    await giveReadReplicaTimeToCatchUp();
    await clearWaveGroupsCache();
    res.send(wave);
  }
);

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, any, SearchWavesParams, any>,
    res: Response<ApiResponse<ApiWave[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const params = await validateWavesSearchParams(req);
    const waves = await waveApiService.searchWaves(params, {
      authenticationContext,
      timer
    });
    res.send(waves);
  }
);

router.get(
  '/:id',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiWave>>
  ) => {
    const { id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req);
    const profileId = authenticationContext.getActingAsId();
    const group_ids_user_is_eligible_for =
      !profileId ||
      (authenticationContext.isAuthenticatedAsProxy() &&
        !authenticationContext.activeProxyActions[
          ProfileProxyActionType.READ_WAVE
        ])
        ? []
        : await userGroupsService.getGroupsUserIsEligibleFor(profileId);
    const wave = await waveApiService.findWaveByIdOrThrow(
      id,
      group_ids_user_is_eligible_for,
      { authenticationContext, timer }
    );

    res.send(wave);
  }
);

router.delete(
  '/:id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<any>>
  ) => {
    const { id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    await waveApiService.deleteWave(id, { authenticationContext, timer });
    res.send({});
  }
);

router.post(
  '/:id/subscriptions',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, ApiWaveSubscriptionActions, any, any>,
    res: Response<ApiResponse<ApiWaveSubscriptionActions>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ProfileProxyActionType.READ_WAVE
      ]
    ) {
      throw new ForbiddenException(
        `Proxy is not allowed to read waves or subscribe to them`
      );
    }
    const request = getValidatedByJoiOrThrow(
      req.body,
      WaveSubscriptionActionsSchema
    );
    const activeActions = await waveApiService.addWaveSubscriptionActions({
      waveId: req.params.id,
      subscriber: authenticatedProfileId,
      actions: request.actions
    });
    res.send({
      actions: activeActions
    });
  }
);

router.post(
  '/:id/pins',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<any>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxy is not allowed to pin waves`);
    }
    await waveApiService.pinWave(
      {
        waveId: req.params.id
      },
      { authenticationContext, timer }
    );
    await giveReadReplicaTimeToCatchUp();
    res.send({});
  }
);

router.delete(
  '/:id/pins',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<any>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (authenticationContext.isAuthenticatedAsProxy()) {
      throw new ForbiddenException(`Proxy is not allowed to unpin waves`);
    }
    await waveApiService.unPinWave(
      {
        waveId: req.params.id
      },
      { authenticationContext, timer }
    );
    await giveReadReplicaTimeToCatchUp();
    res.send({});
  }
);

router.post(
  '/:id/mute',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<any>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    await waveApiService.muteWave(
      { waveId: req.params.id },
      { authenticationContext, timer }
    );
    await giveReadReplicaTimeToCatchUp();
    res.send({});
  }
);

router.delete(
  '/:id/mute',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<any>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    await waveApiService.unmuteWave(
      { waveId: req.params.id },
      { authenticationContext, timer }
    );
    await giveReadReplicaTimeToCatchUp();
    res.send({});
  }
);

router.delete(
  '/:id/subscriptions',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, ApiWaveSubscriptionActions, any, any>,
    res: Response<ApiResponse<ApiWaveSubscriptionActions>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
    const authenticatedProfileId = authenticationContext.getActingAsId();
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    if (
      authenticationContext.isAuthenticatedAsProxy() &&
      !authenticationContext.activeProxyActions[
        ProfileProxyActionType.READ_WAVE
      ]
    ) {
      throw new ForbiddenException(
        `Proxy is not allowed to read waves or unsubscribe for them`
      );
    }
    const request = getValidatedByJoiOrThrow(
      req.body,
      WaveSubscriptionActionsSchema
    );
    const activeActions = await waveApiService.removeWaveSubscriptionActions({
      waveId: req.params.id,
      subscriber: authenticatedProfileId,
      actions: request.actions
    });
    res.send({
      actions: activeActions
    });
  }
);

router.get(
  '/:id/drops',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { id: string },
      any,
      any,
      {
        drop_id?: string;
        limit?: string;
        serial_no_less_than?: string;
        serial_no_limit?: string;
        search_strategy?: string;
        drop_type?: ApiDropType;
      },
      any
    >,
    res: Response<ApiResponse<ApiWaveDropsFeed>>
  ) => {
    const { id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req);
    const dropId = req.query.drop_id ?? null;
    const amount = numbers.parseIntOrNull(req.query.limit) ?? 200;
    const serialNoLessThan = numbers.parseIntOrNull(
      req.query.serial_no_less_than
    );
    const serialNoLimit =
      serialNoLessThan ?? numbers.parseIntOrNull(req.query.serial_no_limit);
    const searchStrategy =
      serialNoLessThan === null
        ? (enums.resolve(ApiDropSearchStrategy, req.query.search_strategy) ??
          ApiDropSearchStrategy.Older)
        : ApiDropSearchStrategy.Older;
    const drop_type_str = req.query.drop_type as string | undefined;
    const drop_type = drop_type_str
      ? (enums.resolve(ApiDropType, drop_type_str) ?? null)
      : null;
    const result = await dropsService.findWaveDropsFeed(
      {
        wave_id: id,
        drop_id: dropId,
        amount: amount >= 200 || amount < 1 ? 50 : amount,
        serial_no_limit: serialNoLimit,
        search_strategy: searchStrategy,
        drop_type
      },
      { authenticationContext, timer }
    );
    res.send(result);
  }
);

router.get(
  '/:id/leaderboard',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { id: string },
      any,
      any,
      Omit<LeaderboardParams, 'wave_id'>,
      any
    >,
    res: Response<ApiResponse<ApiDropsLeaderboardPage>>
  ) => {
    const { id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req);
    const params: LeaderboardParams = {
      wave_id: id,
      ...getValidatedByJoiOrThrow(
        req.query,
        Joi.object<LeaderboardParams>({
          page_size: Joi.number().integer().min(1).max(100).default(50),
          page: Joi.number().integer().min(1).default(1),
          sort_direction: Joi.string()
            .valid(...Object.values(PageSortDirection))
            .default(PageSortDirection.ASC),
          sort: Joi.string()
            .valid(...Object.values(LeaderboardSort))
            .default(LeaderboardSort.RANK)
        })
      )
    };
    const result = await dropsService.findLeaderboard(
      {
        ...params
      },
      {
        authenticationContext,
        timer
      }
    );
    res.send(result);
  }
);

router.get(
  '/:id/logs',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { id: string },
      any,
      any,
      Omit<DropLogsQueryParams, 'log_types'> & { log_types: string | null },
      any
    >,
    res: Response<ApiResponse<ApiWaveLog[]>>
  ) => {
    const { id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req);
    const params: Omit<DropLogsQueryParams, 'log_types' | 'wave_id'> & {
      log_types: string | null;
    } = getValidatedByJoiOrThrow(
      req.query,
      Joi.object<
        Omit<DropLogsQueryParams, 'log_types' | 'wave_id'> & {
          log_types: string | null;
        }
      >({
        drop_id: Joi.string().optional().default(null),
        offset: Joi.number().integer().optional().min(0).default(0),
        limit: Joi.number().integer().optional().min(1).default(20).max(100),
        sort_direction: Joi.string()
          .valid(...Object.values(PageSortDirection))
          .default(PageSortDirection.DESC),
        log_types: Joi.string().optional().default(null)
      })
    );
    let logTypes = params.log_types?.split(`,`) ?? [];
    if (logTypes.length === 1 && logTypes[0] === '') {
      logTypes = [];
    }
    const unknownLogType = logTypes.find(
      (it) => !DROP_LOG_TYPES.includes(it as any)
    );
    if (unknownLogType) {
      throw new BadRequestException(
        `Unknown log type: ${unknownLogType}. Valid options are ${DROP_LOG_TYPES.join(
          `, `
        )}`
      );
    }
    if (logTypes.length === 0) {
      logTypes = [...DROP_LOG_TYPES];
    }
    const result = await dropsService.findWaveLogs(
      {
        ...params,
        wave_id: id,
        log_types: logTypes
      },
      {
        authenticationContext,
        timer
      }
    );
    res.send(result);
  }
);

router.get(
  '/:id/voters',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { id: string },
      any,
      any,
      Omit<DropVotersStatsParams, 'wave_id'>,
      any
    >,
    res: Response<ApiResponse<ApiWaveVotersPage>>
  ) => {
    const { id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req);
    const params: DropVotersStatsParams = {
      wave_id: id,
      ...getValidatedByJoiOrThrow(
        req.query,
        Joi.object<Omit<DropVotersStatsParams, 'wave_id'>>({
          page_size: Joi.number().integer().min(1).max(100).default(50),
          page: Joi.number().integer().min(1).default(1),
          sort_direction: Joi.string()
            .valid(...Object.values(PageSortDirection))
            .default(PageSortDirection.DESC),
          sort: Joi.string()
            .valid(...Object.values(DropVotersStatsSort))
            .default(DropVotersStatsSort.ABSOLUTE),
          drop_id: Joi.string().optional().default(null)
        })
      )
    };
    const result = await dropsService.findVotersInfo(params, {
      authenticationContext,
      timer
    });
    res.send(result);
  }
);

router.get(
  '/:wave_id/search',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { wave_id: string },
      any,
      any,
      { term: string; page: number; size: number },
      any
    >,
    res: Response<ApiResponse<ApiDropWithoutWavesPageWithoutCount>>
  ) => {
    const { wave_id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req);
    const { term, page, size } = getValidatedByJoiOrThrow(
      req.query,
      Joi.object<{ term: string; page: number; size: number }>({
        term: Joi.string().min(1).required(),
        size: Joi.number().integer().min(1).max(100).optional().default(20),
        page: Joi.number().integer().min(1).optional().default(1)
      })
    );
    const result = await dropsService.searchDropsContainingPhraseInWave(
      { term, page, size, wave_id },
      {
        authenticationContext,
        timer
      }
    );
    res.send(result);
  }
);

router.get(
  '/:id/decisions',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { id: string },
      any,
      any,
      Omit<WaveDecisionsQuery, 'wave_id'>,
      any
    >,
    res: Response<ApiResponse<ApiWaveDecisionsPage>>
  ) => {
    const { id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);

    const params: WaveDecisionsQuery = {
      wave_id: id,
      ...getValidatedByJoiOrThrow(
        req.query,
        Joi.object<Omit<WaveDecisionsQuery, 'wave_id'>>({
          page_size: Joi.number().integer().min(1).max(2000).default(100),
          page: Joi.number().integer().min(1).default(1),
          sort_direction: Joi.string()
            .valid(...Object.values(PageSortDirection))
            .default(PageSortDirection.DESC),
          sort: Joi.string()
            .valid(...Object.values(WaveDecisionsQuerySort))
            .default(WaveDecisionsQuerySort.decision_time)
        })
      )
    };
    const result = await waveDecisionsApiService.searchConcludedWaveDecisions(
      params,
      {
        authenticationContext,
        timer
      }
    );
    res.send(result);
  }
);

router.get(
  '/:wave_id/outcomes',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { wave_id: string },
      any,
      any,
      Omit<WaveOutcomesQuery, 'wave_id'>,
      any
    >,
    res: Response<ApiResponse<ApiWaveOutcomesPage>>
  ) => {
    const { wave_id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);

    const params: WaveOutcomesQuery = {
      wave_id: wave_id,
      ...getValidatedByJoiOrThrow(
        req.query,
        Joi.object<Omit<WaveDecisionsQuery, 'wave_id'>>({
          page_size: Joi.number().integer().min(1).max(2000).default(100),
          page: Joi.number().integer().min(1).default(1),
          sort_direction: Joi.string()
            .valid(...Object.values(PageSortDirection))
            .default(PageSortDirection.DESC)
        })
      )
    };
    const result = await waveDecisionsApiService.getOutcomes(params, {
      authenticationContext,
      timer
    });
    res.send(result);
  }
);

router.get(
  '/:wave_id/outcomes/:index/distribution',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { wave_id: string; index: number },
      any,
      any,
      Omit<WaveOutcomeDistributionQuery, 'wave_id' | 'outcome_index'>,
      any
    >,
    res: Response<ApiResponse<ApiWaveOutcomeDistributionItemsPage>>
  ) => {
    const { wave_id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);

    const params: WaveOutcomeDistributionQuery = {
      wave_id: wave_id,
      ...getValidatedByJoiOrThrow(
        { ...req.query, outcome_index: req.params.index },
        Joi.object<Omit<WaveOutcomeDistributionQuery, 'wave_id'>>({
          page_size: Joi.number().integer().min(1).max(2000).default(100),
          page: Joi.number().integer().min(1).default(1),
          sort_direction: Joi.string()
            .valid(...Object.values(PageSortDirection))
            .default(PageSortDirection.DESC),
          outcome_index: Joi.number().required().integer().min(1)
        })
      )
    };
    const result = await waveDecisionsApiService.getOutcomeDistribution(
      params,
      {
        authenticationContext,
        timer
      }
    );
    res.send(result);
  }
);

router.post(
  '/:id/pauses',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, ApiUpdateWaveDecisionPause, any, any>,
    res: Response<ApiResponse<ApiWave>>
  ) => {
    const { id } = req.params;

    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);

    const model: ApiUpdateWaveDecisionPause = getValidatedByJoiOrThrow(
      req.body,
      Joi.object<ApiUpdateWaveDecisionPause>({
        id: Joi.number().integer().allow(null).default(null),
        start_time: Joi.number().integer().min(0).required(),
        end_time: Joi.number().integer().min(0).required()
      })
    );

    const result = await waveApiService.createOrUpdateWavePause(id, model, {
      timer,
      authenticationContext
    });
    res.send(result);
  }
);

router.delete(
  '/:waveId/pauses/:id',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ waveId: string; id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiWave>>
  ) => {
    const { waveId, id } = req.params;
    const pauseId = numbers.parseIntOrNull(id);
    if (!pauseId) {
      throw new BadRequestException('Invalid pause id');
    }

    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);

    const result = await waveApiService.deleteWavePause(waveId, pauseId, {
      timer,
      authenticationContext
    });
    res.send(result);
  }
);

const IntRangeSchema = Joi.object<ApiIntRange>({
  min: Joi.number().integer().required().allow(null),
  max: Joi.number().integer().required().allow(null)
})
  .custom((value, helpers) => {
    const min = numbers.parseIntOrNull(value?.min);
    const max = numbers.parseIntOrNull(value?.max);
    if (min !== null && max !== null && min > max) {
      return helpers.error('min.max.flip');
    }
    return { min, max };
  })
  .messages({
    'min.max.flip': `There's a range in request where max is less than min. This is not allowed.`
  });

const WaveScopeSchema = Joi.object<ApiCreateNewWaveScope>({
  group_id: Joi.string().required().allow(null)
});

const WaveVisibilitySchema = Joi.object<ApiCreateNewWaveVisibilityConfig>({
  scope: WaveScopeSchema.required()
});

const WaveVotingSchema = Joi.object<ApiCreateNewWaveVotingConfig>({
  scope: WaveScopeSchema.required(),
  credit_type: Joi.string()
    .valid(...Object.values(ApiWaveCreditType))
    .required(),
  credit_scope: Joi.string()
    .optional()
    .valid(...Object.values(ApiWaveCreditScope))
    .default(ApiWaveCreditScope.Wave),
  credit_category: Joi.when('credit_type', {
    is: Joi.string().valid(ApiWaveCreditType.Rep),
    then: Joi.string().required().allow(null).max(100),
    otherwise: Joi.valid(null)
  }),
  creditor_id: Joi.when('credit_type', {
    is: Joi.string().valid(ApiWaveCreditType.Rep),
    then: Joi.string().required().allow(null),
    otherwise: Joi.valid(null)
  }),
  signature_required: Joi.boolean().optional().default(false),
  period: IntRangeSchema.required().allow(null),
  forbid_negative_votes: Joi.boolean().optional().default(false)
});

const WaveRequiredMetadataSchema = Joi.object<ApiWaveRequiredMetadata>({
  name: Joi.string().required().max(250).min(1),
  type: Joi.string()
    .required()
    .valid(...Object.values(ApiWaveParticipationRequirement))
});

const WaveParticipationSchema = Joi.object<ApiCreateNewWaveParticipationConfig>(
  {
    scope: WaveScopeSchema.required(),
    no_of_applications_allowed_per_participant: Joi.number()
      .integer()
      .required()
      .allow(null),
    required_metadata: Joi.array()
      .required()
      .min(0)
      .items(WaveRequiredMetadataSchema),
    required_media: Joi.array()
      .items(
        Joi.string().valid(...Object.values(ApiWaveParticipationRequirement))
      )
      .optional()
      .default([]),
    signature_required: Joi.boolean().optional().default(false),
    period: IntRangeSchema.required().allow(null),
    terms: Joi.string().optional().allow(null).default(null)
  }
);

const WaveChatSchema = Joi.object<ApiCreateNewWaveChatConfig>({
  scope: WaveScopeSchema.required(),
  enabled: Joi.boolean().optional().default(true)
});

const WaveDecisionsStrategySchema = Joi.object<ApiWaveDecisionsStrategy>({
  first_decision_time: Joi.number()
    .integer()
    .required()
    .min(Time.currentMillis())
    .message('first_decision_time must be in the future'),
  subsequent_decisions: Joi.array()
    .required()
    .items(Joi.number().integer().min(Time.hours(1).toMillis())),
  is_rolling: Joi.boolean().required()
});

const WaveConfigSchema = Joi.object<
  ApiWaveConfig & { period?: ApiIntRange | null }
>({
  type: Joi.string()
    .required()
    .valid(...Object.values(ApiWaveType)),
  winning_thresholds: Joi.when('type', {
    is: Joi.string().valid(ApiWaveType.Approve),
    then: IntRangeSchema.required().or('min', 'max'),
    otherwise: Joi.valid(null)
  }),
  max_winners: Joi.when('type', {
    is: Joi.string().valid(ApiWaveType.Rank),
    then: Joi.number().integer().required().allow(null).min(1),
    otherwise: Joi.valid(null)
  }),
  time_lock_ms: Joi.number()
    .integer()
    .required()
    .allow(null)
    .min(Time.minutes(5).toMillis()),
  period: IntRangeSchema.optional(),
  admin_group: WaveScopeSchema.required(),
  decisions_strategy: WaveDecisionsStrategySchema.optional().allow(null),
  admin_drop_deletion_enabled: Joi.boolean().optional().default(false)
});

const WaveOutcomeDistributionItemSchema =
  Joi.object<ApiWaveOutcomeDistributionItem>({
    amount: Joi.number().integer().optional().min(0).allow(null),
    description: Joi.string().optional().min(1).max(500).allow(null)
  });

const WaveOutcomeSchema = Joi.object<ApiCreateWaveOutcome>({
  type: Joi.string()
    .required()
    .valid(...Object.values(ApiWaveOutcomeType)),
  subtype: Joi.when('type', {
    is: ApiWaveOutcomeType.Automatic,
    then: Joi.string()
      .required()
      .valid(...Object.values(ApiWaveOutcomeSubType)),
    otherwise: Joi.optional().valid(null)
  }),
  description: Joi.string().required().max(250).min(1),
  credit: Joi.when('subtype', {
    is: ApiWaveOutcomeSubType.CreditDistribution,
    then: Joi.string()
      .required()
      .valid(...Object.values(ApiWaveOutcomeCredit)),
    otherwise: Joi.optional().valid(null)
  }),
  rep_category: Joi.when('credit', {
    is: ApiWaveOutcomeCredit.Rep,
    then: Joi.string()
      .required()
      .min(3)
      .max(100)
      .regex(REP_CATEGORY_PATTERN)
      .messages({
        'string.pattern.base': `Invalid category. Category can't be longer than 100 characters. It can only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes.`
      }),
    otherwise: Joi.optional().valid(null)
  }),
  amount: Joi.when('subtype', {
    is: ApiWaveOutcomeSubType.CreditDistribution,
    then: Joi.number().integer().required().min(1),
    otherwise: Joi.optional().valid(null)
  }),
  distribution: Joi.array()
    .items(WaveOutcomeDistributionItemSchema)
    .optional()
    .default([])
});

const waveSchemaBaseValidations = {
  name: Joi.string().required().max(250).min(1),
  picture: Joi.string()
    .optional()
    .allow(null)
    .regex(/^https:\/\/d3lqz0a4bldqgf.cloudfront.net\//),
  voting: WaveVotingSchema.required(),
  visibility: WaveVisibilitySchema.required(),
  participation: WaveParticipationSchema.required(),
  chat: WaveChatSchema.optional().default({ scope: { group_id: null } }),
  wave: WaveConfigSchema.required(),
  outcomes: Joi.array().required().min(0).items(WaveOutcomeSchema)
};

const WaveSchema = Joi.object<ApiCreateNewWave>({
  ...waveSchemaBaseValidations,
  description_drop: NewWaveDropSchema.required()
});

const UpdateWaveSchema = Joi.object<ApiUpdateWaveRequest>({
  ...waveSchemaBaseValidations
});

const WaveSubscriptionActionsSchema = Joi.object<ApiWaveSubscriptionActions>({
  actions: Joi.array()
    .items(
      Joi.string().valid(...Object.values(ApiWaveSubscriptionTargetAction))
    )
    .required()
});

export async function validateWavesSearchParams(
  req: Request<any, any, any, SearchWavesParams, any>
): Promise<SearchWavesParams> {
  const validatedRequest = getValidatedByJoiOrThrow(
    req.query,
    Joi.object<SearchWavesParams>({
      name: Joi.string().optional(),
      author: Joi.string().optional(),
      limit: Joi.number().integer().min(1).max(50).default(20),
      serial_no_less_than: Joi.number().integer().min(1).optional(),
      group_id: Joi.string().optional().min(1),
      direct_message: Joi.boolean().truthy('true').falsy('false').optional()
    })
  );
  if (validatedRequest.author) {
    const authorId = await identityFetcher.getProfileIdByIdentityKeyOrThrow(
      { identityKey: validatedRequest.author },
      { timer: Timer.getFromRequest(req) }
    );
    return {
      ...validatedRequest,
      author: authorId
    };
  }
  return validatedRequest;
}

export default router;
