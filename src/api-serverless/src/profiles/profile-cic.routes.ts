import { asyncRouter } from '../async.router';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getValidatedByJoiOrThrow } from '../validation';
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
import { ApiRatingWithProfileInfoAndLevelPage } from '../generated/models/ApiRatingWithProfileInfoAndLevelPage';
import { identityFetcher } from '../identities/identity.fetcher';
import { Timer } from '../../../time';
import { ApiIdentity } from '../generated/models/ApiIdentity';
import { ProfileClassification } from '../../../entities/IProfile';
import { enums } from '../../../enums';

const router = asyncRouter({ mergeParams: true });

function isAuthenticatedWalletProfileOwner(
  req: Request,
  identity: ApiIdentity | null
) {
  const authenticatedWallet = getWalletOrThrow(req);
  return (
    identity?.wallets?.find(
      (it) => it.wallet.toLowerCase() === authenticatedWallet
    ) ?? false
  );
}

router.get(
  `/rating/:raterIdentity`,
  async function (
    req: GetRaterAggregatedRatingRequest,
    res: Response<ApiResponse<ApiProfileRaterCicState>>
  ) {
    const timer = Timer.getFromRequest(req);
    const targetIdentityKey = req.params.identity.toLowerCase();
    const raterIdentityKey = req.params.raterIdentity.toLowerCase();
    const targetProfileId = await identityFetcher.getProfileIdByIdentityKey(
      { identityKey: targetIdentityKey },
      { timer }
    );
    const raterProfileId = await identityFetcher.getProfileIdByIdentityKey(
      { identityKey: raterIdentityKey },
      { timer }
    );
    const { rating: cicRatingByRater } =
      targetProfileId && raterProfileId
        ? await ratingsService.getAggregatedRatingOnMatter({
            rater_profile_id: raterProfileId,
            matter: RateMatter.CIC,
            matter_category: RateMatter.CIC,
            matter_target_id: targetProfileId
          })
        : { rating: 0 };
    const cicRatingsLeftToGiveByRater = raterProfileId
      ? await ratingsService.getRatesLeftOnMatterForProfile({
          profile_id: raterProfileId,
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
    res: Response<ApiResponse<any>>
  ) {
    const { amount } = getValidatedByJoiOrThrow(
      req.body,
      ChangeProfileCicRatingSchema
    );
    const { authContext, targetProfileId } = await getRaterInfoFromRequest(req);
    await ratingsService.updateRating(
      {
        authenticationContext: authContext,
        rater_profile_id: authContext.getActingAsId()!,
        matter: RateMatter.CIC,
        matter_category: 'CIC',
        matter_target_id: targetProfileId,
        rating: amount
      },
      { authenticationContext: authContext, timer: Timer.getFromRequest(req) }
    );
    await giveReadReplicaTimeToCatchUp();
    res.status(201).send({});
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
    const resolvedProfileId = await identityFetcher.getProfileIdByIdentityKey(
      { identityKey: identity },
      { timer: Timer.getFromRequest(req) }
    );
    if (resolvedProfileId) {
      const statements =
        await cicService.getCicStatementsByProfileId(resolvedProfileId);
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
    const resolvedProfileId =
      await identityFetcher.getProfileIdByIdentityKeyOrThrow(
        { identityKey: identity },
        { timer: Timer.getFromRequest(req) }
      );
    const statement = await cicService.getCicStatementByIdAndProfileIdOrThrow({
      id: statementId,
      profile_id: resolvedProfileId
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
    const resolvedIdentity =
      await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey: identity },
        { timer: Timer.getFromRequest(req) }
      );
    if (!isAuthenticatedWalletProfileOwner(req, resolvedIdentity)) {
      throw new ForbiddenException(
        `User can only add statements to their own profile`
      );
    }
    const statementId = req.params.statementId;
    const profileId = resolvedIdentity?.id;
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
    const resolvedIdentity =
      await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey: identity },
        { timer: Timer.getFromRequest(req) }
      );
    if (!isAuthenticatedWalletProfileOwner(req, resolvedIdentity)) {
      throw new ForbiddenException(
        `User can only add statements to its own profile`
      );
    }
    const requestPayload = getValidatedByJoiOrThrow(
      req.body,
      ApiCreateOrUpdateProfileCicStatementSchema
    );
    const profileId = resolvedIdentity?.id;
    if (!profileId) {
      throw new NotFoundException(`No profile found for ${identity}`);
    }
    const updatedStatement = await cicService.addCicStatement({
      profile: {
        profile_id: profileId,
        classification:
          enums.resolve(
            ProfileClassification,
            resolvedIdentity.classification
          ) ?? null,
        handle: resolvedIdentity.handle!
      },
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
