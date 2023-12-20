import { asyncRouter } from '../async.router';
import { needsAuthenticatedUser } from '../auth/auth';
import { Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
import { BadRequestException } from '../../../exceptions';
import * as Joi from 'joi';
import {
  ProfilesMatterRatingWithRaterLevel,
  ratingsService
} from '../../../rates/ratings.service';
import { RateMatter } from '../../../entities/IRating';
import { REP_CATEGORY_PATTERN } from '../../../entities/IAbusivenessDetectionResult';
import { abusivenessCheckService } from '../../../profiles/abusiveness-check.service';
import { Page } from '../page-request';
import {
  GetProfileRatingsRequest,
  getRaterInfoFromRequest,
  getRatingsSearchParamsFromRequest,
  RateProfileRequest
} from './rating.helper';

const router = asyncRouter({ mergeParams: true });

router.get(
  `/ratings`,
  async function (
    req: GetProfileRatingsRequest,
    res: Response<ApiResponse<Page<ProfilesMatterRatingWithRaterLevel>>>
  ) {
    const {
      order,
      order_by,
      page,
      page_size,
      targetProfile,
      rater_profile_id
    } = await getRatingsSearchParamsFromRequest(req);

    const results = await ratingsService.getPageOfRatingsForMatter({
      rater_profile_id: rater_profile_id,
      matter: RateMatter.REP,
      matter_target_id: targetProfile.external_id,
      page_request: {
        page: page > 0 ? page : 1,
        page_size: page_size > 0 ? page_size : 200
      },
      order: order,
      order_by: order_by
    });
    res.send(results);
  }
);

router.post(
  `/rating`,
  needsAuthenticatedUser(),
  async function (
    req: RateProfileRequest<ApiAddRepRatingToProfileRequest>,
    res: Response<ApiResponse<void>>
  ) {
    const { amount, category } = getValidatedByJoiOrThrow(
      req.body,
      ApiAddRepRatingToProfileRequestSchema
    );
    const proposedCategory = category?.trim() ?? '';
    const { raterProfileId, targetProfileId } = await getRaterInfoFromRequest(
      req
    );
    if (proposedCategory !== '') {
      const abusivenessDetectionResult =
        await abusivenessCheckService.checkAbusiveness(category);
      if (abusivenessDetectionResult.status === 'DISALLOWED') {
        throw new BadRequestException(`Given category is not allowed`);
      }
    }
    await ratingsService.updateRating({
      rater_profile_id: raterProfileId,
      matter: RateMatter.REP,
      matter_category: proposedCategory,
      matter_target_id: targetProfileId,
      rating: amount
    });
    res.status(201);
  }
);

interface ApiAddRepRatingToProfileRequest {
  readonly amount: number;
  readonly category: string;
}

const ApiAddRepRatingToProfileRequestSchema: Joi.ObjectSchema<ApiAddRepRatingToProfileRequest> =
  Joi.object({
    amount: Joi.number().integer().required(),
    category: Joi.string().max(100).regex(REP_CATEGORY_PATTERN).messages({
      'string.pattern.base': `Invalid category. Category can't be longer than 100 characters. It can only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes.`
    })
  });

export default router;
