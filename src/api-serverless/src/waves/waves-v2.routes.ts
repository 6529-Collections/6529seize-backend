import { Request, Response } from 'express';
import * as Joi from 'joi';
import { enums } from '@/enums';
import { numbers } from '@/numbers';
import { Timer } from '@/time';
import { ApiResponse } from '@/api/api-response';
import { asyncRouter } from '@/api/async.router';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser
} from '@/api/auth/auth';
import { dropsService } from '@/api/drops/drops.api.service';
import { ApiDropsLeaderboardPageV2 } from '@/api/generated/models/ApiDropsLeaderboardPageV2';
import { ApiDropSearchStrategy } from '@/api/generated/models/ApiDropSearchStrategy';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { ApiWaveDecisionsPageV2 } from '@/api/generated/models/ApiWaveDecisionsPageV2';
import { ApiWaveDropsFeedV2 } from '@/api/generated/models/ApiWaveDropsFeedV2';
import { ApiWaveOverviewPage } from '@/api/generated/models/ApiWaveOverviewPage';
import { ApiWavesOverviewType } from '@/api/generated/models/ApiWavesOverviewType';
import { ApiWavesPinFilter } from '@/api/generated/models/ApiWavesPinFilter';
import { ApiWavesV2ListType } from '@/api/generated/models/ApiWavesV2ListType';
import { PageSortDirection } from '@/api/page-request';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  waveDecisionsApiService,
  WaveDecisionsQuery,
  WaveDecisionsQuerySort
} from '@/api/waves/wave-decisions-api.service';
import {
  apiWaveV2Service,
  FindWavesV2Request
} from '@/api/waves/api-wave-v2.service';
import { ApiDropV2PageWithoutCount } from '@/api/generated/models/ApiDropV2PageWithoutCount';
import { LeaderboardParams, LeaderboardSort } from '@/drops/drops.db';

const router = asyncRouter();

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, any, Partial<FindWavesV2Request>, any>,
    res: Response<ApiResponse<ApiWaveOverviewPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const params = validateWavesV2Params(req.query);
    const result = await apiWaveV2Service.findWaves(params, {
      authenticationContext,
      timer
    });
    res.send(result);
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
        limit?: string;
        serial_no_limit?: string;
        search_strategy?: string;
        drop_type?: ApiDropType;
      },
      any
    >,
    res: Response<ApiResponse<ApiWaveDropsFeedV2>>
  ) => {
    const { id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const amount = numbers.parseIntOrNull(req.query.limit) ?? 200;
    const serialNoLimit = numbers.parseIntOrNull(req.query.serial_no_limit);
    const searchStrategy =
      enums.resolve(ApiDropSearchStrategy, req.query.search_strategy) ??
      ApiDropSearchStrategy.Older;
    const dropType = req.query.drop_type
      ? (enums.resolve(ApiDropType, req.query.drop_type) ?? null)
      : null;
    const result = await apiWaveV2Service.findDropsFeed(
      {
        wave_id: id,
        drop_id: null,
        amount: amount >= 200 || amount < 1 ? 50 : amount,
        serial_no_limit: serialNoLimit,
        search_strategy: searchStrategy,
        drop_type: dropType,
        curation_id: null
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
    res: Response<ApiResponse<ApiDropsLeaderboardPageV2>>
  ) => {
    const { id } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const params: LeaderboardParams = {
      wave_id: id,
      ...getValidatedByJoiOrThrow(
        req.query,
        Joi.object<LeaderboardParams>({
          page_size: Joi.number().integer().min(1).max(100).default(50),
          page: Joi.number().integer().min(1).default(1),
          curation_id: Joi.string().optional().default(null),
          unvoted_by_me: Joi.boolean().optional().default(false),
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
    const result = await dropsService.findLeaderboardV2(params, {
      authenticationContext,
      timer
    });
    res.send(result);
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
    res: Response<ApiResponse<ApiDropV2PageWithoutCount>>
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
    const result = await apiWaveV2Service.findWaveCurationDrops(
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
    res: Response<ApiResponse<ApiWaveDecisionsPageV2>>
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
    const result = await waveDecisionsApiService.searchConcludedWaveDecisionsV2(
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
  '/:waveId/search',
  maybeAuthenticatedUser(),
  async (
    req: Request<
      { waveId: string },
      any,
      any,
      { term: string; page: number; size: number },
      any
    >,
    res: Response<ApiResponse<ApiDropV2PageWithoutCount>>
  ) => {
    const { waveId } = req.params;
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const { term, page, size } = getValidatedByJoiOrThrow(
      req.query,
      Joi.object<{ term: string; page: number; size: number }>({
        term: Joi.string().min(1).required(),
        size: Joi.number().integer().min(1).max(100).optional().default(20),
        page: Joi.number().integer().min(1).optional().default(1)
      })
    );
    const result = await apiWaveV2Service.searchDropsContainingPhraseInWave(
      { term, page, size, wave_id: waveId },
      {
        authenticationContext,
        timer
      }
    );
    res.send(result);
  }
);

function validateWavesV2Params(
  query: Partial<FindWavesV2Request>
): FindWavesV2Request {
  const queryToValidate = query as FindWavesV2Request;
  const { view } = getValidatedByJoiOrThrow(
    query as { view: ApiWavesV2ListType },
    Joi.object<{ view: ApiWavesV2ListType }>({
      view: Joi.string()
        .uppercase()
        .valid(...Object.values(ApiWavesV2ListType))
        .default(ApiWavesV2ListType.Search)
    }).unknown(true)
  );

  switch (view) {
    case ApiWavesV2ListType.Search:
      return getValidatedByJoiOrThrow(
        queryToValidate,
        Joi.object<FindWavesV2Request>({
          view: waveListViewSchema().default(ApiWavesV2ListType.Search),
          page: Joi.number().integer().min(1).default(1),
          page_size: Joi.number().integer().min(1).max(50).default(20),
          name: Joi.string().trim().min(1).optional(),
          author: Joi.string().trim().min(1).optional(),
          serial_no_less_than: Joi.number().integer().min(1).optional(),
          group_id: Joi.string().trim().min(1).optional(),
          direct_message: booleanQuerySchema().optional()
        }).unknown(false)
      );
    case ApiWavesV2ListType.Overview:
      return getValidatedByJoiOrThrow(
        queryToValidate,
        Joi.object<FindWavesV2Request>({
          view: waveListViewSchema().required(),
          page: Joi.number().integer().min(1).default(1),
          page_size: Joi.number().integer().min(1).max(20).default(10),
          overview_type: Joi.string()
            .uppercase()
            .valid(...Object.values(ApiWavesOverviewType))
            .required(),
          only_waves_followed_by_authenticated_user: booleanQuerySchema()
            .optional()
            .default(false),
          direct_message: booleanQuerySchema().optional(),
          pinned: Joi.string()
            .uppercase()
            .empty('')
            .valid(...Object.values(ApiWavesPinFilter))
            .optional()
            .default(null)
        }).unknown(false)
      );
    case ApiWavesV2ListType.Hot:
      return getValidatedByJoiOrThrow(
        queryToValidate,
        Joi.object<FindWavesV2Request>({
          view: waveListViewSchema().required(),
          page: Joi.number().integer().min(1).default(1),
          page_size: Joi.number().integer().min(1).max(25).default(25),
          exclude_followed: booleanQuerySchema().optional().default(false)
        }).unknown(false)
      );
    case ApiWavesV2ListType.Favourites:
      return getValidatedByJoiOrThrow(
        queryToValidate,
        Joi.object<FindWavesV2Request>({
          view: waveListViewSchema().required(),
          page: Joi.number().integer().min(1).default(1),
          page_size: Joi.number().integer().min(1).max(100).default(50),
          identity: Joi.string().trim().required().min(1).max(200)
        }).unknown(false)
      );
  }
  throw new Error(`Unsupported V2 waves view ${view}`);
}

function waveListViewSchema() {
  return Joi.string()
    .uppercase()
    .valid(...Object.values(ApiWavesV2ListType));
}

function booleanQuerySchema() {
  return Joi.boolean().truthy('true').falsy('false');
}

export default router;
