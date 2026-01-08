import { Request, Response } from 'express';
import * as Joi from 'joi';
import { ApiResponse } from '../api-response';
import { asyncRouter } from '../async.router';
import { ApiCommunityMetrics } from '../generated/models/ApiCommunityMetrics';
import { getValidatedByJoiOrThrow } from '../validation';
import { communityMetricsService } from './community-metrics.service';
import { Timer } from '../../../time';
import { RequestContext } from '../../../request.context';
import { cacheRequest } from '../request-cache';

const router = asyncRouter();

type CommunityMetricsQuery = {
  interval: 'DAY' | 'WEEK';
};

const CommunityMetricsQuerySchema: Joi.ObjectSchema<CommunityMetricsQuery> =
  Joi.object({
    interval: Joi.string().valid('DAY', 'WEEK').required()
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
    const response = await communityMetricsService.getCommunityMetrics(
      query.interval,
      ctx
    );
    res.send(response);
  }
);

export default router;
