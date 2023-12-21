import { asyncRouter } from '../async.router';
import { needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import * as Joi from 'joi';
import { ratingsService } from '../../../rates/ratings.service';
import { RateMatter } from '../../../entities/IRating';
import { REP_CATEGORY_PATTERN } from '../../../entities/IAbusivenessDetectionResult';
import { abusivenessCheckService } from '../../../profiles/abusiveness-check.service';
import { getRaterInfoFromRequest, RateProfileRequest } from './rating.helper';
import { profilesService } from '../../../profiles/profiles.service';
import { RatingStats } from '../../../rates/ratings.db';

const router = asyncRouter({ mergeParams: true });

router.get(
  `/ratings`,
  async function (
    req: Request<
      { handleOrWallet: string },
      any,
      any,
      {
        rater?: string | null;
      },
      any
    >,
    res: Response<ApiResponse<ApiProfileRepRatesState>>
  ) {
    const targetHandleOrWallet = req.params.handleOrWallet.toLowerCase();
    const raterHandleOrWallet = req.query.rater?.toLowerCase() ?? null;

    const targetProfileAndConsolidations =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        targetHandleOrWallet
      );
    const targetProfile = targetProfileAndConsolidations?.profile;
    if (!targetProfile) {
      throw new NotFoundException(
        `No profile found for ${targetHandleOrWallet}`
      );
    }
    const raterProfileAndConsolidations = !raterHandleOrWallet
      ? null
      : await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
          raterHandleOrWallet
        );
    const raterProfile = raterProfileAndConsolidations?.profile;
    const repRatesLeftForRater = raterProfile
      ? await ratingsService.getRatesLeftOnMatterForProfile({
          profile_id: raterProfile.external_id,
          matter: RateMatter.REP
        })
      : null;

    const ratingStats =
      await ratingsService.getAllRatingsForMatterOnProfileGroupedByCategories({
        matter: RateMatter.REP,
        matter_target_id: targetProfile.external_id,
        rater_profile_id: raterProfile?.external_id ?? null
      });

    res.send({
      total_rep_rating: ratingStats.reduce(
        (acc, it) => acc + (it.rating ?? 0),
        0
      ),
      total_rep_rating_by_rater: !raterProfile
        ? null
        : ratingStats.reduce(
            (acc, it) => acc + (it.rater_contribution ?? 0),
            0
          ),
      rep_rates_left_for_rater: repRatesLeftForRater,
      rating_stats: ratingStats
    });
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

interface ApiProfileRepRatesState {
  readonly total_rep_rating: number;
  readonly total_rep_rating_by_rater: number | null;
  readonly rep_rates_left_for_rater: number | null;
  readonly rating_stats: RatingStats[];
}

export default router;
