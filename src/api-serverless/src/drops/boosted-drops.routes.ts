import { Request, Response } from 'express';
import * as Joi from 'joi';
import { Timer } from '../../../time';
import { ApiResponse } from '../api-response';
import { asyncRouter } from '../async.router';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { getValidatedByJoiOrThrow } from '../validation';
import { dropsService, FindBoostedDropsRequest } from './drops.api.service';
import { ApiPageSortDirection } from '../generated/models/ApiPageSortDirection';
import { DEFAULT_MAX_SIZE, DEFAULT_PAGE_SIZE } from '../page-request';
import { ApiDropsPage } from '../generated/models/ApiDropsPage';

const router = asyncRouter();

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, FindBoostedDropsRequest, any>,
    res: Response<ApiResponse<ApiDropsPage>>
  ) => {
    const timer = Timer.getFromRequest(req);

    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx = { timer, authenticationContext };
    const searchRequest: FindBoostedDropsRequest = getValidatedByJoiOrThrow(
      req.query,
      FindBoostedDropsRequestSchema
    );
    const resultingPage = await dropsService.findBoostedDrops(
      searchRequest,
      ctx
    );
    res.send(resultingPage);
  }
);

const FindBoostedDropsRequestSchema = Joi.object<FindBoostedDropsRequest>({
  author: Joi.string().default(null),
  booster: Joi.string().default(null),
  wave_id: Joi.string().default(null),
  min_boosts: Joi.number().integer().default(null),
  page_size: Joi.number()
    .integer()
    .default(DEFAULT_PAGE_SIZE)
    .max(DEFAULT_MAX_SIZE)
    .min(1),
  page: Joi.number().integer().default(1).min(1),
  sort_direction: Joi.string()
    .valid(...Object.values(ApiPageSortDirection))
    .default(ApiPageSortDirection.Desc),
  sort: Joi.string()
    .valid('last_boosted_at', 'first_boosted_at', 'drop_created_at', 'boosts')
    .default('last_boosted_at')
});

export default router;
