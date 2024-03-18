import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
import * as Joi from 'joi';
import {
  ratingsService,
  RatingsSnapshotsPageRequest
} from '../../../rates/ratings.service';
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_PAGE_SIZE,
  Page,
  PageSortDirection
} from '../page-request';
import { RatingsSnapshot } from '../../../entities/IRatingsSnapshots';
import { RateMatter } from '../../../entities/IRating';

const router = asyncRouter();

router.get(
  `/snapshots`,
  async function (
    req: Request<any, any, any, RatingsSnapshotsPageRequest, any>,
    res: Response<ApiResponse<Page<RatingsSnapshot>>>
  ) {
    const pageRequest = getValidatedByJoiOrThrow(
      req.query,
      SnapshotsRequestSchema
    );
    const page = await ratingsService.getRatingsSnapshotsPage(pageRequest);
    res.send(page);
  }
);

const SnapshotsRequestSchema: Joi.ObjectSchema<RatingsSnapshotsPageRequest> =
  Joi.object({
    page: Joi.number().integer().optional().min(1).default(1),
    page_size: Joi.number()
      .integer()
      .optional()
      .min(1)
      .max(DEFAULT_MAX_SIZE)
      .default(DEFAULT_PAGE_SIZE),
    sort: Joi.string()
      .valid('snapshot_time')
      .optional()
      .default('snapshot_time'),
    sort_direction: Joi.string()
      .valid(...Object.values(PageSortDirection))
      .optional()
      .default(PageSortDirection.DESC),
    matter: Joi.string()
      .optional()
      .valid(...Object.values(RateMatter))
      .default(null)
  });

export default router;
