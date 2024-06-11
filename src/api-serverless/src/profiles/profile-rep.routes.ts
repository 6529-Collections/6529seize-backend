import { asyncRouter } from '../async.router';
import { needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
import { BadRequestException } from '../../../exceptions';
import * as Joi from 'joi';
import {
  GetProfileRatingsRequest,
  ratingsService
} from '../../../rates/ratings.service';
import { RateMatter } from '../../../entities/IRating';
import { REP_CATEGORY_PATTERN } from '../../../entities/IAbusivenessDetectionResult';
import { abusivenessCheckService } from '../../../profiles/abusiveness-check.service';
import { getRaterInfoFromRequest, RateProfileRequest } from './rating.helper';
import { profilesService } from '../../../profiles/profiles.service';
import { RatingStats } from '../../../rates/ratings.db';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { ChangeProfileRepRating } from '../generated/models/ChangeProfileRepRating';
import { ChangeProfileRepRatingResponse } from '../generated/models/ChangeProfileRepRatingResponse';
import { RepRating } from '../generated/models/RepRating';
import { RatingWithProfileInfoAndLevel } from '../generated/models/RatingWithProfileInfoAndLevel';
import { RatingWithProfileInfoAndLevelPage } from '../generated/models/RatingWithProfileInfoAndLevelPage';

const router = asyncRouter({ mergeParams: true });

async function getReceivedRatingsStats(
  raterProfileId: string | null,
  targetProfileId: string | null
): Promise<ApiProfileReceivedRepRatesState> {
  const repRatesLeftForRater = raterProfileId
    ? await ratingsService.getRatesLeftOnMatterForProfile({
        profile_id: raterProfileId,
        matter: RateMatter.REP
      })
    : null;

  const ratingStats = targetProfileId
    ? await ratingsService.getAllRatingsForMatterOnProfileGroupedByCategories({
        matter: RateMatter.REP,
        matter_target_id: targetProfileId,
        rater_profile_id: raterProfileId ?? null
      })
    : [];

  const numberOfProfileReppers = targetProfileId
    ? await ratingsService.getNumberOfRatersForMatterOnProfile({
        matter: RateMatter.REP,
        profile_id: targetProfileId
      })
    : 0;

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
    res: Response<ApiResponse<RatingWithProfileInfoAndLevelPage>>
  ) {
    const result = await ratingsService.getRatingsByRatersForMatter({
      queryParams: req.query,
      identity: req.params.identity,
      matter: RateMatter.REP
    });
    res.send(result);
  }
);

router.get(
  `/ratings/received`,
  async function (
    req: Request<
      { identity: string },
      any,
      any,
      {
        rater?: string | null;
      },
      any
    >,
    res: Response<ApiResponse<ApiProfileReceivedRepRatesState>>
  ) {
    const identity = req.params.identity.toLowerCase();
    const raterIdentity = req.query.rater?.toLowerCase() ?? null;

    const targetIdentity = await profilesService.resolveIdentityOrThrowNotFound(
      identity
    );
    const raterProfileAndConsolidations = !raterIdentity
      ? null
      : await profilesService.getProfileAndConsolidationsByIdentity(
          raterIdentity
        );
    const raterProfileId = raterProfileAndConsolidations?.profile?.external_id;
    const response = await getReceivedRatingsStats(
      raterProfileId ?? null,
      targetIdentity.profile_id
    );
    res.send(response);
  }
);

router.get(
  `/ratings/received/category-raters`,
  async function (
    req: Request<
      { identity: string },
      any,
      any,
      {
        category?: string;
      },
      any
    >,
    res: Response<ApiResponse<RatingWithProfileInfoAndLevel[]>>
  ) {
    const targetIdendity = req.params.identity.toLowerCase();
    const category = req.query.category;
    if (!category) {
      throw new BadRequestException(`Query parameter "category" is required`);
    }

    const resolvedTargetIdentity =
      await profilesService.resolveIdentityOrThrowNotFound(targetIdendity);
    const response: RatingWithProfileInfoAndLevel[] =
      resolvedTargetIdentity.profile_id
        ? await ratingsService.getRatingsForMatterAndCategoryOnProfileWithRatersInfo(
            {
              matter: RateMatter.REP,
              matter_target_id: resolvedTargetIdentity.profile_id,
              matter_category: category
            }
          )
        : [];
    res.send(response);
  }
);

router.post(
  `/rating`,
  needsAuthenticatedUser(),
  async function (
    req: RateProfileRequest<ChangeProfileRepRating>,
    res: Response<ApiResponse<ChangeProfileRepRatingResponse>>
  ) {
    const { amount, category } = getValidatedByJoiOrThrow(
      req.body,
      ChangeProfileRepRatingSchema
    );
    const proposedCategory = category?.trim() ?? '';
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
    const { authContext, targetProfileId } = await getRaterInfoFromRequest(req);
    const { total, byUser } = await ratingsService.updateRating({
      authenticationContext: authContext,
      rater_profile_id: authContext.getActingAsId()!,
      matter: RateMatter.REP,
      matter_category: proposedCategory,
      matter_target_id: targetProfileId,
      rating: amount
    });
    await giveReadReplicaTimeToCatchUp();
    res.send({
      total_rep_rating_for_category: total,
      rep_rating_for_category_by_user: byUser
    });
  }
);

router.get(
  `/rating`,
  async function (
    req: Request<
      { identity: string },
      any,
      any,
      { readonly from_identity?: string; readonly category: string },
      any
    >,
    res: Response<ApiResponse<RepRating>>
  ) {
    const identity = req.params.identity;
    const { category, from_identity } = req.query;
    const [resolvedTargetIdentity, resolvedRaterIdentity] = await Promise.all([
      profilesService.resolveIdentityOrThrowNotFound(identity),
      from_identity
        ? profilesService.resolveIdentityOrThrowNotFound(from_identity)
        : null
    ]);
    if (
      (from_identity && !resolvedRaterIdentity) ||
      !resolvedTargetIdentity.profile_id
    ) {
      res.send({ rating: 0 });
    } else {
      const repRating = await ratingsService.getRepRating({
        rater_profile_id: resolvedRaterIdentity?.profile_id ?? null,
        target_profile_id: resolvedTargetIdentity.profile_id,
        category: category ?? null
      });
      res.send({
        rating: repRating
      });
    }
  }
);

const ChangeProfileRepRatingSchema: Joi.ObjectSchema<ChangeProfileRepRating> =
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
