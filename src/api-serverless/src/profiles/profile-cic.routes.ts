import { asyncRouter } from '../async.router';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { ProfileAndConsolidations } from '../../../profiles/profile.types';
import { getValidatedByJoiOrThrow } from '../validation';
import { profilesService } from '../../../profiles/profiles.service';
import { ForbiddenException, NotFoundException } from '../../../exceptions';
import * as Joi from 'joi';
import {
  CicStatement,
  CicStatementGroup
} from '../../../entities/ICICStatement';
import {
  GetProfileRatingsRequest,
  ratingsService
} from '../../../rates/ratings.service';
import { RateMatter } from '../../../entities/IRating';
import { cicService } from '../../../cic/cic.service';
import {
  GetRaterAggregatedRatingRequest,
  getRaterInfoFromRequest,
  RateProfileRequest
} from './rating.helper';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { ApiChangeProfileCicRating } from '../generated/models/ApiChangeProfileCicRating';
import { ApiChangeProfileCicRatingResponse } from '../generated/models/ApiChangeProfileCicRatingResponse';
import { ApiRatingWithProfileInfoAndLevelPage } from '../generated/models/ApiRatingWithProfileInfoAndLevelPage';

const router = asyncRouter({ mergeParams: true });

function isAuthenticatedWalletProfileOwner(
  req: Request,
  profileAndConsolidations: ProfileAndConsolidations | null
) {
  const authenticatedWallet = getWalletOrThrow(req);
  return (
    profileAndConsolidations?.consolidation?.wallets?.find(
      (it) => it.wallet.address.toLowerCase() === authenticatedWallet
    ) ?? false
  );
}

router.get(
  `/rating/:raterIdentity`,
  async function (
    req: GetRaterAggregatedRatingRequest,
    res: Response<ApiResponse<ApiProfileRaterCicState>>
  ) {
    const identity = req.params.identity.toLowerCase();
    const raterIdentity = req.params.raterIdentity.toLowerCase();
    const profileAndConsolidationsOfTarget =
      await profilesService.getProfileAndConsolidationsByIdentity(identity);
    const targetProfile = profileAndConsolidationsOfTarget?.profile;
    const profileAndConsolidationsOfRater =
      await profilesService.getProfileAndConsolidationsByIdentity(
        raterIdentity
      );
    const raterProfile = profileAndConsolidationsOfRater?.profile;
    const { rating: cicRatingByRater } =
      targetProfile && raterProfile
        ? await ratingsService.getAggregatedRatingOnMatter({
            rater_profile_id: raterProfile.external_id,
            matter: RateMatter.CIC,
            matter_category: RateMatter.CIC,
            matter_target_id: targetProfile.external_id
          })
        : { rating: 0 };
    const cicRatingsLeftToGiveByRater = raterProfile
      ? await ratingsService.getRatesLeftOnMatterForProfile({
          profile_id: raterProfile.external_id,
          matter: RateMatter.CIC
        })
      : 0;
    res.send({
      cic_rating_by_rater: cicRatingByRater,
      cic_ratings_left_to_give_by_rater: cicRatingsLeftToGiveByRater
    });
  }
);

router.get(
  `/ratings/by-rater`,
  async function (
    req: GetProfileRatingsRequest,
    res: Response<ApiResponse<ApiRatingWithProfileInfoAndLevelPage>>
  ) {
    const result = await ratingsService.getRatingsByRatersForMatter({
      queryParams: req.query,
      identity: req.params.identity,
      matter: RateMatter.CIC
    });
    res.send(result);
  }
);

router.post(
  `/rating`,
  needsAuthenticatedUser(),
  async function (
    req: RateProfileRequest<ApiChangeProfileCicRating>,
    res: Response<ApiResponse<ApiChangeProfileCicRatingResponse>>
  ) {
    const { amount } = getValidatedByJoiOrThrow(
      req.body,
      ChangeProfileCicRatingSchema
    );
    const { authContext, targetProfileId } = await getRaterInfoFromRequest(req);
    const { total, byUser } = await ratingsService.updateRating({
      authenticationContext: authContext,
      rater_profile_id: authContext.getActingAsId()!,
      matter: RateMatter.CIC,
      matter_category: 'CIC',
      matter_target_id: targetProfileId,
      rating: amount
    });
    await giveReadReplicaTimeToCatchUp();
    res.status(201).send({
      total_cic_rating: total,
      cic_rating_by_user: byUser
    });
  }
);

router.get(
  `/statements`,
  async function (
    req: Request<
      {
        identity: string;
      },
      any,
      any,
      any,
      any
    >,
    res: Response<ApiResponse<CicStatement[]>>
  ) {
    const identity = req.params.identity.toLowerCase();
    const resolvedIdentity =
      await profilesService.resolveIdentityOrThrowNotFound(identity);
    if (resolvedIdentity.profile_id) {
      const statements = await cicService.getCicStatementsByProfileId(
        resolvedIdentity.profile_id
      );
      res.status(200).send(statements);
    } else {
      res.status(200).send([]);
    }
  }
);

router.get(
  `/statements/:statementId`,
  async function (
    req: Request<
      {
        identity: string;
        statementId: string;
      },
      any,
      any,
      any,
      any
    >,
    res: Response<ApiResponse<CicStatement>>
  ) {
    const identity = req.params.identity.toLowerCase();
    const statementId = req.params.statementId;
    const profileAndConsolidations =
      await profilesService.getProfileAndConsolidationsByIdentity(identity);
    const profileId = profileAndConsolidations?.profile?.external_id;
    if (!profileId) {
      throw new NotFoundException(`No profile found for ${identity}`);
    }
    const statement = await cicService.getCicStatementByIdAndProfileIdOrThrow({
      id: statementId,
      profile_id: profileId
    });
    res.status(200).send(statement);
  }
);

router.delete(
  `/statements/:statementId`,
  needsAuthenticatedUser(),
  async function (
    req: Request<
      {
        identity: string;
        statementId: string;
      },
      any,
      any,
      any,
      any
    >,
    res: Response
  ) {
    const identity = req.params.identity.toLowerCase();
    const profileAndConsolidations =
      await profilesService.getProfileAndConsolidationsByIdentity(identity);
    if (!isAuthenticatedWalletProfileOwner(req, profileAndConsolidations)) {
      throw new ForbiddenException(
        `User can only add statements to their own profile`
      );
    }
    const statementId = req.params.statementId;
    const profileId = profileAndConsolidations?.profile?.external_id;
    if (!profileId) {
      throw new NotFoundException(`No profile found for ${identity}`);
    }
    await cicService.deleteCicStatement({
      id: statementId,
      profile_id: profileId
    });
    await giveReadReplicaTimeToCatchUp();
    res.status(201).send();
  }
);

router.post(
  `/statements`,
  needsAuthenticatedUser(),
  async function (
    req: Request<
      {
        identity: string;
      },
      any,
      ApiCreateOrUpdateProfileCicStatement,
      any,
      any
    >,
    res: Response
  ) {
    const identity = req.params.identity.toLowerCase();
    const profileAndConsolidations =
      await profilesService.getProfileAndConsolidationsByIdentity(identity);
    if (!isAuthenticatedWalletProfileOwner(req, profileAndConsolidations)) {
      throw new ForbiddenException(
        `User can only add statements to its own profile`
      );
    }
    const requestPayload = getValidatedByJoiOrThrow(
      req.body,
      ApiCreateOrUpdateProfileCicStatementSchema
    );
    const profile = profileAndConsolidations?.profile;
    const profileId = profile?.external_id;
    if (!profileId) {
      throw new NotFoundException(`No profile found for ${identity}`);
    }
    const updatedStatement = await cicService.addCicStatement({
      profile: profile,
      statement: {
        profile_id: profileId,
        ...requestPayload
      }
    });
    await giveReadReplicaTimeToCatchUp();
    res.status(201).send(updatedStatement);
  }
);

const ChangeProfileCicRatingSchema: Joi.ObjectSchema<ApiChangeProfileCicRating> =
  Joi.object({
    amount: Joi.number().integer().required()
  });

type ApiCreateOrUpdateProfileCicStatement = Omit<
  CicStatement,
  'id' | 'crated_at' | 'updated_at' | 'profile_id'
>;

const ApiCreateOrUpdateProfileCicStatementSchema: Joi.ObjectSchema<ApiCreateOrUpdateProfileCicStatement> =
  Joi.object({
    statement_group: Joi.string()
      .valid(...Object.values(CicStatementGroup))
      .required(),
    statement_type: Joi.string().required().min(1).max(250),
    statement_comment: Joi.optional().default(null),
    statement_value: Joi.string().min(1).required()
  });

interface ApiProfileRaterCicState {
  readonly cic_rating_by_rater: number | null;
  readonly cic_ratings_left_to_give_by_rater: number | null;
}

export default router;
