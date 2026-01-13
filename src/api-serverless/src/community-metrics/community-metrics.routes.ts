import { Request, Response } from 'express';
import * as Joi from 'joi';
import { ApiResponse } from '../api-response';
import { asyncRouter } from '../async.router';
import { ApiCommunityMetrics } from '../generated/models/ApiCommunityMetrics';
import { ApiMintMetricsPage } from '../generated/models/ApiMintMetricsPage';
import { getValidatedByJoiOrThrow } from '../validation';
import { communityMetricsService } from './community-metrics.service';
import { Time, Timer } from '../../../time';
import { RequestContext } from '../../../request.context';
import { cacheRequest } from '../request-cache';
import { DEFAULT_MAX_SIZE, DEFAULT_PAGE_SIZE } from '../page-request';
import { ApiPageSortDirection } from '../generated/models/ApiPageSortDirection';

const router = asyncRouter();

type CommunityMetricsQuery = {
  interval: 'DAY' | 'WEEK';
};

const CommunityMetricsQuerySchema: Joi.ObjectSchema<CommunityMetricsQuery> =
  Joi.object({
    interval: Joi.string().valid('DAY', 'WEEK').required()
  });

type MintMetricsQuery = {
  page: number;
  page_size: number;
  sort_direction: ApiPageSortDirection;
  sort: 'mint_time';
};

const MintMetricsQuerySchema: Joi.ObjectSchema<MintMetricsQuery> = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  page_size: Joi.number()
    .integer()
    .min(1)
    .max(DEFAULT_MAX_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  sort_direction: Joi.string()
    .valid(...Object.values(ApiPageSortDirection))
    .default(ApiPageSortDirection.Desc),
  sort: Joi.string().valid('mint_time').default('mint_time')
});

router.get(
  `/`,
  cacheRequest(),
  async (
    req: Request<any, any, any, CommunityMetricsQuery, any>,
    res: Response<ApiResponse<ApiCommunityMetrics>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const query = getValidatedByJoiOrThrow(
      req.query,
      CommunityMetricsQuerySchema
    );
    const ctx: RequestContext = { timer };
    const response = await communityMetricsService.getCommunityMetricsSummary(
      query.interval,
      ctx
    );
    res.send(response);
  }
);

router.get(
  `/mints`,
  cacheRequest({ ttl: Time.minutes(15) }),
  async (
    req: Request<any, any, any, MintMetricsQuery, any>,
    res: Response<ApiResponse<ApiMintMetricsPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const query = getValidatedByJoiOrThrow(req.query, MintMetricsQuerySchema);
    const ctx: RequestContext = { timer };
    const response = await communityMetricsService.getCommunityMintMetrics(
      query,
      ctx
    );
    res.send(response);
  }
);

export default router;
