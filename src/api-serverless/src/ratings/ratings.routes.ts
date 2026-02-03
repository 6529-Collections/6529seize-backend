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
import { ApiRateMatter } from '../generated/models/ApiRateMatter';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { REP_CATEGORY_PATTERN } from '../../../entities/IAbusivenessDetectionResult';
import { WALLET_REGEX } from '@/constants';
import { abusivenessCheckService } from '../../../profiles/abusiveness-check.service';
import { BadRequestException } from '../../../exceptions';
import { ApiBulkRateResponse } from '../generated/models/ApiBulkRateResponse';
import { ApiBulkRateRequest } from '../generated/models/ApiBulkRateRequest';
import { ApiAvailableRatingCredit } from '../generated/models/ApiAvailableRatingCredit';
import { identityFetcher } from '../identities/identity.fetcher';
import { Timer } from '../../../time';

const router = asyncRouter();

router.post(
  `/`,
  needsAuthenticatedUser(),
  async function (
    req: Request<any, any, ApiBulkRateRequest, any, any>,
    res: Response<ApiResponse<ApiBulkRateResponse>>
  ) {
    let apiRequest = getValidatedByJoiOrThrow(req.body, BulkRateRequestSchema);
    const authContext = await getAuthenticationContext(req);
    if (apiRequest.matter === ApiRateMatter.Rep) {
      const proposedCategory = apiRequest.category?.trim() ?? '';
      if (proposedCategory !== '') {
        const abusivenessDetectionResult =
          await abusivenessCheckService.checkRepPhrase(proposedCategory);
        if (abusivenessDetectionResult.status === 'DISALLOWED') {
          throw new BadRequestException(
            abusivenessDetectionResult.explanation ??
              'Given category is not allowed'
          );
        }
        apiRequest = { ...apiRequest, category: proposedCategory };
      } else {
        throw new BadRequestException('Category is required');
      }
    }
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

router.get(
  `/credit`,
  async function (
    req: Request<
      any,
      any,
      any,
      { rater: string; rater_representative: string | null },
      any
    >,
    res: Response<ApiResponse<ApiAvailableRatingCredit>>
  ) {
    const timer = Timer.getFromRequest(req);
    const request = getValidatedByJoiOrThrow(
      req.query,
      CreditLeftRequestSchema
    );
    const rater_id = await identityFetcher.getProfileIdByIdentityKey(
      { identityKey: request.rater },
      { timer }
    );
    if (!rater_id) {
      res.send({
        cic_credit: 0,
        rep_credit: 0
      });
      return;
    }
    let rater_representative_id: string | null = null;
    if (request.rater_representative) {
      rater_representative_id = await identityFetcher.getProfileIdByIdentityKey(
        { identityKey: request.rater_representative },
        { timer }
      );
      if (!rater_representative_id) {
        res.send({
          cic_credit: 0,
          rep_credit: 0
        });
        return;
      }
    }
    const page = await ratingsService.getCreditLeft({
      rater_id,
      rater_representative_id
    });
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

const BulkRateRequestSchema: Joi.ObjectSchema<ApiBulkRateRequest> =
  Joi.object<ApiBulkRateRequest>({
    amount_to_add: Joi.number().integer().not(0).required(),
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

const CreditLeftRequestSchema = Joi.object<{
  rater: string;
  rater_representative: string | null;
}>({
  rater: Joi.string().required().min(1),
  rater_representative: Joi.string().allow(null).optional().default(null)
});

export default router;
