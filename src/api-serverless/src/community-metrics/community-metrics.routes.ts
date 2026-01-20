import { Request, Response } from 'express';
import * as Joi from 'joi';
import { ApiResponse } from '../api-response';
import { asyncRouter } from '../async.router';
import { ApiCommunityMetrics } from '../generated/models/ApiCommunityMetrics';
import { ApiCommunityMetricsSeries } from '../generated/models/ApiCommunityMetricsSeries';
import { ApiMintMetricsPage } from '../generated/models/ApiMintMetricsPage';
import { getValidatedByJoiOrThrow } from '../validation';
import {
  CommunityMetricsSeriesQuery,
  communityMetricsService
} from './community-metrics.service';
import { Time, Timer } from '../../../time';
import { RequestContext } from '../../../request.context';
import { cacheRequest } from '../request-cache';
import { DEFAULT_MAX_SIZE, DEFAULT_PAGE_SIZE } from '../page-request';
import { ApiPageSortDirection } from '../generated/models/ApiPageSortDirection';
import { numbers } from '../../../numbers';

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

const CommunityMetricsSeriesQuerySchema: Joi.ObjectSchema<CommunityMetricsSeriesQuery> =
  Joi.object({
    since: Joi.number().integer().required(),
    to: Joi.number().integer().required()
  })
    .custom((value, helpers) => {
      const since = numbers.parseIntOrNull(value?.since);
      const to = numbers.parseIntOrNull(value?.to);
      if (since === null || to === null) {
        return helpers.error('any.invalid');
      }
      if (to <= since) {
        return helpers.error('metrics.series.to.not.after.since');
      }
      const stepMs = Time.days(1).toMillis();
      if (to - since < stepMs) {
        return helpers.error('metrics.series.to.too.close');
      }
      if (to - since > Time.days(365).toMillis()) {
        return helpers.error('metrics.series.too.large');
      }
      if (to > Time.now().toMillis()) {
        return helpers.error('metrics.series.future');
      }
      return { since, to };
    })
    .messages({
      'metrics.series.to.not.after.since': `"to" must be greater than "since".`,
      'metrics.series.to.too.close': `"to" must be at least one day after "since".`,
      'metrics.series.too.large': `"since" and "to" cannot be more than 365 days apart.`,
      'metrics.series.future': `"to" cannot be in the future.`
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
  `/series`,
  cacheRequest(),
  async (
    req: Request<any, any, any, CommunityMetricsSeriesQuery, any>,
    res: Response<ApiResponse<ApiCommunityMetricsSeries>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const query = getValidatedByJoiOrThrow(
      req.query,
      CommunityMetricsSeriesQuerySchema
    );
    const ctx: RequestContext = { timer };
    const response = await communityMetricsService.getCommunityMetricsSeries(
      query,
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
