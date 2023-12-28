import { asyncRouter } from '../async.router';
import { needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import * as Joi from 'joi';
import {
  RatingWithProfileInfoAndLevel,
  ratingsService
} from '../../../rates/ratings.service';
import { RateMatter } from '../../../entities/IRating';
import { REP_CATEGORY_PATTERN } from '../../../entities/IAbusivenessDetectionResult';
import { abusivenessCheckService } from '../../../profiles/abusiveness-check.service';
import { getRaterInfoFromRequest, RateProfileRequest } from './rating.helper';
import { profilesService } from '../../../profiles/profiles.service';
import { RatingStats } from '../../../rates/ratings.db';
import { Page } from '../page-request';

const router = asyncRouter({ mergeParams: true });

async function getReceivedRatingsStats(
  raterProfileId: string | null,
  targetProfileId: string
): Promise<ApiProfileReceivedRepRatesState> {
  const repRatesLeftForRater = raterProfileId
    ? await ratingsService.getRatesLeftOnMatterForProfile({
        profile_id: raterProfileId,
        matter: RateMatter.REP
      })
    : null;

  const ratingStats =
    await ratingsService.getAllRatingsForMatterOnProfileGroupedByCategories({
      matter: RateMatter.REP,
      matter_target_id: targetProfileId,
      rater_profile_id: raterProfileId ?? null
    });

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
    req: Request<
      { handleOrWallet: string },
      any,
      any,
      {
        given?: string;
        page?: string;
        page_size?: string;
      },
      any
    >,
    res: Response<ApiResponse<Page<RatingWithProfileInfoAndLevel>>>
  ) {
    const given = req.query.given === 'true';
    const page = req.query.page ? parseInt(req.query.page) : 1;
    const page_size = req.query.page_size ? parseInt(req.query.page_size) : 200;
    const handleOrWallet = req.params.handleOrWallet.toLowerCase();
    const profile =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        handleOrWallet
      );
    const profile_id = profile?.profile?.external_id;
    if (!profile_id) {
      throw new NotFoundException(`No profile found for ${handleOrWallet}`);
    }
    const result = await ratingsService.getRatingsByRatersForMatter({
      profileId: profile_id,
      matter: RateMatter.REP,
      given: given,
      page: page,
      page_size: page_size
    });
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
        targetHandleOrWallet
      );
    const targetProfileId =
      targetProfileAndConsolidations?.profile?.external_id;
    const raterProfileAndConsolidations = !raterHandleOrWallet
      ? null
      : await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
          raterHandleOrWallet
        );
    const raterProfileId = raterProfileAndConsolidations?.profile?.external_id;
    if (!targetProfileId) {
      throw new NotFoundException(
        `No profile found for ${targetHandleOrWallet}`
      );
    }
    const response = await getReceivedRatingsStats(
      raterProfileId ?? null,
      targetProfileId
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
        targetHandleOrWallet
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
        await abusivenessCheckService.checkAbusiveness(category);
      if (abusivenessDetectionResult.status === 'DISALLOWED') {
        throw new BadRequestException(abusivenessDetectionResult.explanation);
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
      targetProfileId
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
