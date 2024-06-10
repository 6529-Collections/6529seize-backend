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
import { RateMatter as ApiRateMatter } from '../generated/models/RateMatter';
import { BulkRateRequest } from '../generated/models/BulkRateRequest';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { REP_CATEGORY_PATTERN } from '../../../entities/IAbusivenessDetectionResult';
import { WALLET_REGEX } from '../../../constants';
import { BulkRateResponse } from '../generated/models/BulkRateResponse';

const router = asyncRouter();

router.post(
  `/`,
  needsAuthenticatedUser(),
  async function (
    req: Request<any, any, BulkRateRequest, any, any>,
    res: Response<ApiResponse<BulkRateResponse>>
  ) {
    const apiRequest = getValidatedByJoiOrThrow(
      req.body,
      BulkRateRequestSchema
    );
    const authContext = await getAuthenticationContext(req);
    const response = await ratingsService.bulkRateProfiles(
      authContext,
      apiRequest
    );
    res.send(response);
  }
);

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

const BulkRateRequestSchema: Joi.ObjectSchema<BulkRateRequest> =
  Joi.object<BulkRateRequest>({
    amount: Joi.number().integer().required(),
    matter: Joi.string()
      .valid(...Object.values(ApiRateMatter))
      .required(),
    category: Joi.when('matter', {
      is: RateMatter.REP,
      then: Joi.string()
        .required()
        .min(1)
        .max(100)
        .regex(REP_CATEGORY_PATTERN)
        .messages({
          'string.pattern.base': `Invalid category. Category can't be longer than 100 characters. It can only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes.`
        }),
      otherwise: Joi.allow(null).optional().default(null)
    }),
    target_wallet_addresses: Joi.array()
      .items(Joi.string().regex(WALLET_REGEX).required())
      .min(1)
      .max(100)
      .required()
  });

export default router;
