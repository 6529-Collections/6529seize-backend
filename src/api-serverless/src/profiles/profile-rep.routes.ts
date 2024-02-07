import { asyncRouter } from '../async.router';
import { needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import * as Joi from 'joi';
import {
  GetProfileRatingsRequest,
  ratingsService,
  RatingWithProfileInfoAndLevel
} from '../../../rates/ratings.service';
import { RateMatter } from '../../../entities/IRating';
import { REP_CATEGORY_PATTERN } from '../../../entities/IAbusivenessDetectionResult';
import { abusivenessCheckService } from '../../../profiles/abusiveness-check.service';
import { getRaterInfoFromRequest, RateProfileRequest } from './rating.helper';
import { profilesService } from '../../../profiles/profiles.service';
import { RatingStats } from '../../../rates/ratings.db';
import { Page } from '../page-request';
import { isSafeToUseReadEndpointInProfileApi } from '../api-helpers';

const router = asyncRouter({ mergeParams: true });

async function getReceivedRatingsStats(
  raterProfileId: string | null,
  targetProfileId: string,
  { useReadDbOnReads }: { useReadDbOnReads: boolean }
): Promise<ApiProfileReceivedRepRatesState> {
  const repRatesLeftForRater = raterProfileId
    ? await ratingsService.getRatesLeftOnMatterForProfile({
        profile_id: raterProfileId,
        matter: RateMatter.REP
      })
    : null;

  const ratingStats =
    await ratingsService.getAllRatingsForMatterOnProfileGroupedByCategories(
      {
        matter: RateMatter.REP,
        matter_target_id: targetProfileId,
        rater_profile_id: raterProfileId ?? null
      },
      { useReadDbOnReads }
    );

  const numberOfProfileReppers =
    await ratingsService.getNumberOfRatersForMatterOnProfile({
      matter: RateMatter.REP,
      profile_id: targetProfileId
    });

  return {
    total_rep_rating: ratingStats.reduce(
      (acc, it) => acc + (it.rating ?? 0),
      0
    ),
    total_rep_rating_by_rater: !raterProfileId
      ? null
      : ratingStats.reduce((acc, it) => acc + (it.rater_contribution ?? 0), 0),
    number_of_raters: numberOfProfileReppers,
    rep_rates_left_for_rater: repRatesLeftForRater,
    rating_stats: ratingStats
  };
}

router.get(
  `/ratings/by-rater`,
  async function (
    req: GetProfileRatingsRequest,
    res: Response<ApiResponse<Page<RatingWithProfileInfoAndLevel>>>
  ) {
    const result = await ratingsService.getRatingsByRatersForMatter(
      {
        queryParams: req.query,
        handleOrWallet: req.params.handleOrWallet,
        matter: RateMatter.REP
      },
      { useReadDbOnReads: isSafeToUseReadEndpointInProfileApi(req) }
    );
    res.send(result);
  }
);

router.get(
  `/ratings/received`,
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
    res: Response<ApiResponse<ApiProfileReceivedRepRatesState>>
  ) {
    const targetHandleOrWallet = req.params.handleOrWallet.toLowerCase();
    const raterHandleOrWallet = req.query.rater?.toLowerCase() ?? null;

    const targetProfileAndConsolidations =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        targetHandleOrWallet,
        { useReadDbOnReads: isSafeToUseReadEndpointInProfileApi(req) }
      );
    const targetProfileId =
      targetProfileAndConsolidations?.profile?.external_id;
    const raterProfileAndConsolidations = !raterHandleOrWallet
      ? null
      : await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
          raterHandleOrWallet,
          { useReadDbOnReads: isSafeToUseReadEndpointInProfileApi(req) }
        );
    const raterProfileId = raterProfileAndConsolidations?.profile?.external_id;
    if (!targetProfileId) {
      throw new NotFoundException(
        `No profile found for ${targetHandleOrWallet}`
      );
    }
    const response = await getReceivedRatingsStats(
      raterProfileId ?? null,
      targetProfileId,
      { useReadDbOnReads: isSafeToUseReadEndpointInProfileApi(req) }
    );
    res.send(response);
  }
);

router.get(
  `/ratings/received/category-raters`,
  async function (
    req: Request<
      { handleOrWallet: string },
      any,
      any,
      {
        category?: string;
      },
      any
    >,
    res: Response<ApiResponse<RatingWithProfileInfoAndLevel[]>>
  ) {
    const targetHandleOrWallet = req.params.handleOrWallet.toLowerCase();
    const category = req.query.category;
    if (!category) {
      throw new BadRequestException(`Query parameter "category" is required`);
    }

    const targetProfileAndConsolidations =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        targetHandleOrWallet,
        { useReadDbOnReads: isSafeToUseReadEndpointInProfileApi(req) }
      );
    const targetProfileId =
      targetProfileAndConsolidations?.profile?.external_id;
    if (!targetProfileId) {
      throw new NotFoundException(
        `No profile found for ${targetHandleOrWallet}`
      );
    }
    const response =
      await ratingsService.getRatingsForMatterAndCategoryOnProfileWithRatersInfo(
        {
          matter: RateMatter.REP,
          matter_target_id: targetProfileId,
          matter_category: category
        }
      );
    res.send(response);
  }
);

router.post(
  `/rating`,
  needsAuthenticatedUser(),
  async function (
    req: RateProfileRequest<ApiAddRepRatingToProfileRequest>,
    res: Response<ApiResponse<ApiProfileReceivedRepRatesState>>
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
        await abusivenessCheckService.checkRepPhrase(category);
      if (abusivenessDetectionResult.status === 'DISALLOWED') {
        throw new BadRequestException(
          abusivenessDetectionResult.explanation ??
            'Given category is not allowed'
        );
      }
    }
    await ratingsService.updateRating({
      rater_profile_id: raterProfileId,
      matter: RateMatter.REP,
      matter_category: proposedCategory,
      matter_target_id: targetProfileId,
      rating: amount
    });
    const response = await getReceivedRatingsStats(
      raterProfileId,
      targetProfileId,
      { useReadDbOnReads: isSafeToUseReadEndpointInProfileApi(req) }
    );
    res.send(response);
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

interface ApiProfileReceivedRepRatesState {
  readonly total_rep_rating: number;
  readonly total_rep_rating_by_rater: number | null;
  readonly rep_rates_left_for_rater: number | null;
  readonly number_of_raters: number;
  readonly rating_stats: RatingStats[];
}

export default router;
