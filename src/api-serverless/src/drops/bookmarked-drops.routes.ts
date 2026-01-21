import { Request, Response } from 'express';
import * as Joi from 'joi';
import { Timer } from '../../../time';
import { ApiResponse } from '../api-response';
import { asyncRouter } from '../async.router';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { getValidatedByJoiOrThrow } from '../validation';
import { dropBookmarksApiService } from './drop-bookmarks.api.service';
import { ApiPageSortDirection } from '../generated/models/ApiPageSortDirection';
import { DEFAULT_MAX_SIZE, DEFAULT_PAGE_SIZE } from '../page-request';
import { ApiDropsPage } from '../generated/models/ApiDropsPage';

const router = asyncRouter();

interface GetBookmarkedDropsRequest {
  wave_id: string | null;
  page_size: number;
  page: number;
  sort_direction: ApiPageSortDirection;
}

router.get(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, any, GetBookmarkedDropsRequest>,
    res: Response<ApiResponse<ApiDropsPage>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const ctx = { timer, authenticationContext };
    const searchRequest: GetBookmarkedDropsRequest = getValidatedByJoiOrThrow(
      req.query,
      GetBookmarkedDropsRequestSchema
    );
    const resultingPage = await dropBookmarksApiService.getBookmarkedDrops(
      searchRequest,
      ctx
    );
    res.send(resultingPage);
  }
);

const GetBookmarkedDropsRequestSchema = Joi.object<GetBookmarkedDropsRequest>({
  wave_id: Joi.string().default(null),
  page_size: Joi.number()
    .integer()
    .default(DEFAULT_PAGE_SIZE)
    .max(DEFAULT_MAX_SIZE)
    .min(1),
  page: Joi.number().integer().default(1).min(1),
  sort_direction: Joi.string()
    .valid(...Object.values(ApiPageSortDirection))
    .default(ApiPageSortDirection.Desc)
});

export default router;
