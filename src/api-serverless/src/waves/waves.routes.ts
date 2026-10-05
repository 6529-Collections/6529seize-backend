import { WaveSchema, UpdateWaveSchema } from '@/api/waves/wave-write.schemas';
export {
  WaveSchema,
  UpdateWaveSchema,
  CreateWaveDecisionsStrategySchema
} from '@/api/waves/wave-write.schemas';
import { Request, Response } from 'express';
import * as Joi from 'joi';
import {
  DropLogsQueryParams,
  DropVotersStatsParams,
  DropVotersStatsSort,
  LeaderboardParams,
  LeaderboardSort
} from '../../../drops/drops.db';
import { DROP_LOG_TYPES } from '../../../entities/IProfileActivityLog';
import { ProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import { enums } from '../../../enums';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../../../exceptions';
import { numbers } from '../../../numbers';
import { RequestContext } from '../../../request.context';
import { Time, Timer } from '../../../time';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { ApiResponse } from '../api-response';
import { asyncRouter } from '../async.router';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '../auth/auth';
import { userGroupsService } from '../community-members/user-groups.service';
import { dropsService } from '../drops/drops.api.service';
import { ApiCreateNewWave } from '../generated/models/ApiCreateNewWave';
import { ApiDropSearchStrategy } from '../generated/models/ApiDropSearchStrategy';
import { ApiDropsLeaderboardPage } from '../generated/models/ApiDropsLeaderboardPage';
import { ApiDropType } from '../generated/models/ApiDropType';
import { ApiDropWithoutWavesPageWithoutCount } from '../generated/models/ApiDropWithoutWavesPageWithoutCount';
import { ApiSetPinnedDropRequest } from '../generated/models/ApiSetPinnedDropRequest';
import { ApiUpdateWaveDecisionPause } from '../generated/models/ApiUpdateWaveDecisionPause';
import { ApiUpdateWaveRequest } from '../generated/models/ApiUpdateWaveRequest';
import { ApiWave } from '../generated/models/ApiWave';
import { ApiWaveDecisionsPage } from '../generated/models/ApiWaveDecisionsPage';
import { ApiWaveDropsFeed } from '../generated/models/ApiWaveDropsFeed';
import { ApiWaveLog } from '../generated/models/ApiWaveLog';
import { ApiWaveOutcomeDistributionItemsPage } from '../generated/models/ApiWaveOutcomeDistributionItemsPage';
import { ApiWaveOutcomesPage } from '../generated/models/ApiWaveOutcomesPage';
import { ApiWaveSubscriptionActions } from '../generated/models/ApiWaveSubscriptionActions';
import { ApiWaveSubscriptionTargetAction } from '../generated/models/ApiWaveSubscriptionTargetAction';
import { ApiWaveType } from '../generated/models/ApiWaveType';
import { ApiWaveVotersPage } from '../generated/models/ApiWaveVotersPage';
import { identityFetcher } from '../identities/identity.fetcher';
import { PageSortDirection } from '../page-request';
import { getValidatedByJoiOrThrow } from '../validation';
import {
  waveDecisionsApiService,
  WaveDecisionsQuery,
  WaveDecisionsQuerySort,
  WaveOutcomeDistributionQuery,
  WaveOutcomesQuery
} from './wave-decisions-api.service';
import { waveApiService } from './wave.api.service';
import { SearchWavesParams } from './waves.api.db';
import { ApiWaveCuration } from '@/api/generated/models/ApiWaveCuration';
import { ApiWaveCurationRequest } from '@/api/generated/models/ApiWaveCurationRequest';
import { curationsApiService } from '@/api/curations/curations.api.service';
import { ApiCurationDropsPage } from '@/api/generated/models/ApiCurationDropsPage';
import waveRepRoutes from './wave-rep.routes';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from './wave-score.service';

const router = asyncRouter();

const WaveCurationSchema = Joi.object<ApiWaveCurationRequest>({
  name: Joi.string().trim().min(1).max(50).required(),
  group_id: Joi.string().required(),
  priority_order: Joi.number().integer().min(1).optional()
});

async function handleSimpleWaveAction(
  req: Request<{ id: string }, any, any, any, any>,
  res: Response<ApiResponse<any>>,
  action: (waveId: string, ctx: RequestContext) => Promise<void>,
  options?: { disallowProxy?: boolean; proxyErrorMessage?: string }
) {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req);
  const authenticatedProfileId = authenticationContext.getActingAsId();
  if (!authenticatedProfileId) {
    throw new ForbiddenException(`Please create a profile first`);
  }
  if (
    options?.disallowProxy &&
    authenticationContext.isAuthenticatedAsProxy()
  ) {
    throw new ForbiddenException(
      options.proxyErrorMessage ?? `Proxy is not allowed to perform this action`
    );
  }
  await action(req.params.id, { authenticationContext, timer });
  await giveReadReplicaTimeToCatchUp();
  res.send({});
}

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
          ...request.chat,
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
          ...request.chat,
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
    await userGroupsService.onWaveRelatedGroupsChanged(
      [
        request.visibility.scope.group_id,
        request.participation.scope.group_id,
        request.chat.scope.group_id,
        request.voting.scope.group_id,
        request.wave.admin_group?.group_id
      ],
      requestContext
    );
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

router.use('/:id/rep', waveRepRoutes);

router.get(
  '/:id',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiWave>>
  ) => {
    const { id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
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
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
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
    await waveScoreService.requestWaveScoreRefreshBestEffort(
      [req.params.id],
      WaveScoreDirtyRefreshReason.WAVE_SUBSCRIPTION_CHANGED,
      { authenticationContext, timer }
    );
    res.send({
      actions: activeActions
    });
  }
);

router.post('/:id/pins', needsAuthenticatedUser(), async (req, res) => {
  await handleSimpleWaveAction(
    req,
    res,
    (waveId, ctx) => waveApiService.pinWave({ waveId }, ctx),
    {
      disallowProxy: true,
      proxyErrorMessage: `Proxy is not allowed to pin waves`
    }
  );
});

router.post(
  '/:id/pinned-drop',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, ApiSetPinnedDropRequest, any, any>,
    res: Response<ApiResponse<ApiWave>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const request = getValidatedByJoiOrThrow(req.body, SetPinnedDropSchema);
    const wave = await waveApiService.setPinnedDrop(req.params.id, request, {
      authenticationContext,
      timer
    });
    await giveReadReplicaTimeToCatchUp();
    res.send(wave);
  }
);

router.delete('/:id/pins', needsAuthenticatedUser(), async (req, res) => {
  await handleSimpleWaveAction(
    req,
    res,
    (waveId, ctx) => waveApiService.unPinWave({ waveId }, ctx),
    {
      disallowProxy: true,
      proxyErrorMessage: `Proxy is not allowed to unpin waves`
    }
  );
});

router.post('/:id/mute', needsAuthenticatedUser(), async (req, res) => {
  await handleSimpleWaveAction(req, res, (waveId, ctx) =>
    waveApiService.muteWave({ waveId }, ctx)
  );
});

router.delete('/:id/mute', needsAuthenticatedUser(), async (req, res) => {
  await handleSimpleWaveAction(req, res, (waveId, ctx) =>
    waveApiService.unmuteWave({ waveId }, ctx)
  );
});

router.delete(
  '/:id/subscriptions',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, ApiWaveSubscriptionActions, any, any>,
    res: Response<ApiResponse<ApiWaveSubscriptionActions>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
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
    await waveScoreService.requestWaveScoreRefreshBestEffort(
      [req.params.id],
      WaveScoreDirtyRefreshReason.WAVE_SUBSCRIPTION_CHANGED,
      { authenticationContext, timer }
    );
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
        curation_id?: string;
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
    const curation_id = req.query.curation_id ?? null;
    const result = await dropsService.findWaveDropsFeed(
      {
        wave_id: id,
        drop_id: dropId,
        amount: amount >= 200 || amount < 1 ? 50 : amount,
        serial_no_limit: serialNoLimit,
        search_strategy: searchStrategy,
        drop_type,
        curation_id
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
        Joi.object<Omit<LeaderboardParams, 'wave_id'>>({
          page_size: Joi.number().integer().min(1).max(100).default(50),
          page: Joi.number().integer().min(1).default(1),
          curation_id: Joi.string().optional().default(null),
          unvoted_by_me: Joi.boolean().optional().default(false),
          is_additional_action_promised: Joi.boolean()
            .optional()
            .allow(null)
            .default(null),
          price_currency: Joi.string()
            .trim()
            .empty('')
            .optional()
            .default(null),
          min_price: Joi.number().min(0).optional().default(null),
          max_price: Joi.number().min(0).optional().default(null),
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
  '/:id/curations',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiWaveCuration[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const curations = await curationsApiService.findWaveCurations(
      req.params.id,
      { authenticationContext, timer }
    );
    res.send(curations);
  }
);

router.post(
  '/:id/curations',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string }, any, ApiWaveCurationRequest, any, any>,
    res: Response<ApiResponse<ApiWaveCuration>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const request = getValidatedByJoiOrThrow(req.body, WaveCurationSchema);
    const created = await curationsApiService.createWaveCuration(
      req.params.id,
      request,
      { authenticationContext, timer }
    );
    await giveReadReplicaTimeToCatchUp();
    res.send(created);
  }
);

router.get(
  '/:id/curations/:curation_id/drops',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { id: string; curation_id: string },
      any,
      any,
      { page?: number; page_size?: number },
      any
    >,
    res: Response<ApiResponse<ApiCurationDropsPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const { page, page_size } = getValidatedByJoiOrThrow<{
      page: number;
      page_size: number;
    }>(
      req.query as { page: number; page_size: number },
      Joi.object<{ page: number; page_size: number }>({
        page: Joi.number().integer().min(1).optional().default(1),
        page_size: Joi.number().integer().min(1).max(100).optional().default(50)
      })
    );
    const result = await dropsService.findWaveCurationDrops(
      {
        wave_id: req.params.id,
        curation_id: req.params.curation_id,
        page,
        page_size
      },
      { authenticationContext, timer }
    );
    res.send(result);
  }
);

router.post(
  '/:id/curations/:curationId',
  needsAuthenticatedUser(),
  async (
    req: Request<
      { id: string; curationId: string },
      any,
      ApiWaveCurationRequest,
      any,
      any
    >,
    res: Response<ApiResponse<ApiWaveCuration>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const request = getValidatedByJoiOrThrow(req.body, WaveCurationSchema);
    const updated = await curationsApiService.updateWaveCuration(
      req.params.id,
      req.params.curationId,
      request,
      { authenticationContext, timer }
    );
    await giveReadReplicaTimeToCatchUp();
    res.send(updated);
  }
);

router.delete(
  '/:id/curations/:curationId',
  needsAuthenticatedUser(),
  async (
    req: Request<{ id: string; curationId: string }, any, any, any, any>,
    res: Response<ApiResponse<any>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    await curationsApiService.deleteWaveCuration(
      req.params.id,
      req.params.curationId,
      { authenticationContext, timer }
    );
    await giveReadReplicaTimeToCatchUp();
    res.send({});
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
          is_additional_action_promised: Joi.boolean()
            .optional()
            .allow(null)
            .default(null),
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
        Joi.object<Omit<WaveOutcomesQuery, 'wave_id'>>({
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

const SetPinnedDropSchema = Joi.object<ApiSetPinnedDropRequest>({
  drop_id: Joi.string().required()
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
