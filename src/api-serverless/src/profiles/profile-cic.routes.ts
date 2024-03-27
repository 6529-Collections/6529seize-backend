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
  ratingsService,
  RatingWithProfileInfoAndLevel
} from '../../../rates/ratings.service';
import { RateMatter } from '../../../entities/IRating';
import { Page } from '../page-request';
import { cicService } from '../../../cic/cic.service';
import {
  GetRaterAggregatedRatingRequest,
  getRaterInfoFromRequest,
  RateProfileRequest
} from './rating.helper';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';

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
  `/rating/:raterHandleOrWallet`,
  async function (
    req: GetRaterAggregatedRatingRequest,
    res: Response<ApiResponse<ApiProfileRaterCicState>>
  ) {
    const handleOrWallet = req.params.handleOrWallet.toLowerCase();
    const raterHandleOrWallet = req.params.raterHandleOrWallet.toLowerCase();
    const profileAndConsolidationsOfTarget =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        handleOrWallet
      );
    const targetProfile = profileAndConsolidationsOfTarget?.profile;
    const profileAndConsolidationsOfRater =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        raterHandleOrWallet
      );
    const raterProfile = profileAndConsolidationsOfRater?.profile;
    if (raterProfile && targetProfile) {
      const { rating: cicRatingByRater } =
        await ratingsService.getAggregatedRatingOnMatter({
          rater_profile_id: raterProfile.external_id,
          matter: RateMatter.CIC,
          matter_category: RateMatter.CIC,
          matter_target_id: targetProfile.external_id
        });
      const cicRatingsLeftToGiveByRater =
        await ratingsService.getRatesLeftOnMatterForProfile({
          profile_id: raterProfile.external_id,
          matter: RateMatter.CIC
        });
      res.send({
        cic_rating_by_rater: cicRatingByRater,
        cic_ratings_left_to_give_by_rater: cicRatingsLeftToGiveByRater
      });
    } else {
      res.send({
        cic_rating_by_rater: null,
        cic_ratings_left_to_give_by_rater: null
      });
    }
  }
);

router.get(
  `/ratings/by-rater`,
  async function (
    req: GetProfileRatingsRequest,
    res: Response<ApiResponse<Page<RatingWithProfileInfoAndLevel>>>
  ) {
    const result = await ratingsService.getRatingsByRatersForMatter({
      queryParams: req.query,
      handleOrWallet: req.params.handleOrWallet,
      matter: RateMatter.CIC
    });
    res.send(result);
  }
);

router.post(
  `/rating`,
  needsAuthenticatedUser(),
  async function (
    req: RateProfileRequest<ApiAddCicRatingToProfileRequest>,
    res: Response<ApiResponse<ProfileAndConsolidations>>
  ) {
    const { amount } = getValidatedByJoiOrThrow(
      req.body,
      ApiAddCicRatingToProfileRequestSchema
    );
    const { handleOrWallet, raterProfileId, targetProfileId } =
      await getRaterInfoFromRequest(req);
    await ratingsService.updateRating({
      rater_profile_id: raterProfileId,
      matter: RateMatter.CIC,
      matter_category: 'CIC',
      matter_target_id: targetProfileId,
      rating: amount
    });
    await giveReadReplicaTimeToCatchUp();
    const updatedProfileInfo =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        handleOrWallet
      );
    res.status(201).send(updatedProfileInfo!);
  }
);

router.get(
  `/statements`,
  async function (
    req: Request<
      {
        handleOrWallet: string;
      },
      any,
      any,
      any,
      any
    >,
    res: Response<ApiResponse<CicStatement[]>>
  ) {
    const handleOrWallet = req.params.handleOrWallet.toLowerCase();
    const profileAndConsolidations =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        handleOrWallet
      );
    const profileId = profileAndConsolidations?.profile?.external_id;
    if (!profileId) {
      throw new NotFoundException(`No profile found for ${handleOrWallet}`);
    }
    const statements = await cicService.getCicStatementsByProfileId(profileId);
    res.status(200).send(statements);
  }
);

router.get(
  `/statements/:statementId`,
  async function (
    req: Request<
      {
        handleOrWallet: string;
        statementId: string;
      },
      any,
      any,
      any,
      any
    >,
    res: Response<ApiResponse<CicStatement>>
  ) {
    const handleOrWallet = req.params.handleOrWallet.toLowerCase();
    const statementId = req.params.statementId;
    const profileAndConsolidations =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        handleOrWallet
      );
    const profileId = profileAndConsolidations?.profile?.external_id;
    if (!profileId) {
      throw new NotFoundException(`No profile found for ${handleOrWallet}`);
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
        handleOrWallet: string;
        statementId: string;
      },
      any,
      any,
      any,
      any
    >,
    res: Response
  ) {
    const handleOrWallet = req.params.handleOrWallet.toLowerCase();
    const profileAndConsolidations =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        handleOrWallet
      );
    if (!isAuthenticatedWalletProfileOwner(req, profileAndConsolidations)) {
      throw new ForbiddenException(
        `User can only add statements to their own profile`
      );
    }
    const statementId = req.params.statementId;
    const profileId = profileAndConsolidations?.profile?.external_id;
    if (!profileId) {
      throw new NotFoundException(`No profile found for ${handleOrWallet}`);
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
        handleOrWallet: string;
      },
      any,
      ApiCreateOrUpdateProfileCicStatement,
      any,
      any
    >,
    res: Response
  ) {
    const handleOrWallet = req.params.handleOrWallet.toLowerCase();
    const profileAndConsolidations =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        handleOrWallet
      );
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
      throw new NotFoundException(`No profile found for ${handleOrWallet}`);
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

interface ApiAddCicRatingToProfileRequest {
  readonly amount: number;
}

const ApiAddCicRatingToProfileRequestSchema: Joi.ObjectSchema<ApiAddCicRatingToProfileRequest> =
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
