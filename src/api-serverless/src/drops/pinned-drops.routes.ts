import { Request, Response } from 'express';
import * as Joi from 'joi';
import { Timer } from '../../../time';
import { ApiResponse } from '../api-response';
import { asyncRouter } from '../async.router';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { getValidatedByJoiOrThrow } from '../validation';
import { dropsService, FindPinnedDropsRequest } from './drops.api.service';
import { ApiPageSortDirection } from '../generated/models/ApiPageSortDirection';
import { DEFAULT_MAX_SIZE, DEFAULT_PAGE_SIZE } from '../page-request';
import { ApiDropsPage } from '../generated/models/ApiDropsPage';

const router = asyncRouter();

router.get(
  '/',
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, FindPinnedDropsRequest, any>,
    res: Response<ApiResponse<ApiDropsPage>>
  ) => {
    const timer = Timer.getFromRequest(req);

    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx = { timer, authenticationContext };
    const searchRequest: FindPinnedDropsRequest = getValidatedByJoiOrThrow(
      req.query,
      FindPinnedDropsRequestSchema
    );
    const resultingPage = await dropsService.findPinnedDrops(
      searchRequest,
      ctx
    );
    res.send(resultingPage);
  }
);

const FindPinnedDropsRequestSchema = Joi.object<FindPinnedDropsRequest>({
  author: Joi.string().default(null),
  pinner: Joi.string().default(null),
  wave_id: Joi.string().default(null),
  min_pins: Joi.number().integer().default(null),
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
    .valid(
      'last_pin_timestamp',
      'first_pin_timestamp',
      'drop_created_at',
      'pins_count'
    )
    .default('last_pin_timestamp')
});

export default router;
