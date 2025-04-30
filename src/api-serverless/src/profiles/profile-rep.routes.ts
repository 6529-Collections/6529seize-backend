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
import { RatingStats } from '../../../rates/ratings.db';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { ApiChangeProfileRepRating } from '../generated/models/ApiChangeProfileRepRating';
import { ApiChangeProfileRepRatingResponse } from '../generated/models/ApiChangeProfileRepRatingResponse';
import { ApiRepRating } from '../generated/models/ApiRepRating';
import { ApiRatingWithProfileInfoAndLevel } from '../generated/models/ApiRatingWithProfileInfoAndLevel';
import { ApiRatingWithProfileInfoAndLevelPage } from '../generated/models/ApiRatingWithProfileInfoAndLevelPage';
import { identityFetcher } from '../identities/identity.fetcher';
import { Timer } from '../../../time';

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
    res: Response<ApiResponse<ApiRatingWithProfileInfoAndLevelPage>>
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
    const timer = Timer.getFromRequest(req);
    const targetProfileId =
      await identityFetcher.getProfileIdByIdentityKeyOrThrow(
        { identityKey: identity },
        { timer }
      );
    const raterProfileId = !raterIdentity
      ? null
      : await identityFetcher.getProfileIdByIdentityKey(
          { identityKey: raterIdentity },
          { timer }
        );
    const response = await getReceivedRatingsStats(
      raterProfileId,
      targetProfileId
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
    res: Response<ApiResponse<ApiRatingWithProfileInfoAndLevel[]>>
  ) {
    const targetIdentity = req.params.identity.toLowerCase();
    const category = req.query.category;
    if (!category) {
      throw new BadRequestException(`Query parameter "category" is required`);
    }
    const timer = Timer.getFromRequest(req);
    const targetProfileId = await identityFetcher.getProfileIdByIdentityKey(
      { identityKey: targetIdentity },
      { timer }
    );
    const response: ApiRatingWithProfileInfoAndLevel[] = targetProfileId
      ? await ratingsService.getRatingsForMatterAndCategoryOnProfileWithRatersInfo(
          {
            matter: RateMatter.REP,
            matter_target_id: targetProfileId,
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
    req: RateProfileRequest<ApiChangeProfileRepRating>,
    res: Response<ApiResponse<ApiChangeProfileRepRatingResponse>>
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
    res: Response<ApiResponse<ApiRepRating>>
  ) {
    const identity = req.params.identity;
    const { category, from_identity } = req.query;
    const timer = Timer.getFromRequest(req);
    const [resolvedTargetProfileId, resolvedRaterProfileId] = await Promise.all(
      [
        identityFetcher.getProfileIdByIdentityKeyOrThrow(
          { identityKey: identity },
          { timer }
        ),
        from_identity
          ? identityFetcher.getProfileIdByIdentityKeyOrThrow(
              { identityKey: from_identity },
              { timer }
            )
          : null
      ]
    );
    if (
      (from_identity && !resolvedRaterProfileId) ||
      !resolvedTargetProfileId
    ) {
      res.send({ rating: 0 });
    } else {
      const repRating = await ratingsService.getRepRating({
        rater_profile_id: resolvedRaterProfileId ?? null,
        target_profile_id: resolvedTargetProfileId,
        category: category ?? null
      });
      res.send({
        rating: repRating
      });
    }
  }
);

const ChangeProfileRepRatingSchema: Joi.ObjectSchema<ApiChangeProfileRepRating> =
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
