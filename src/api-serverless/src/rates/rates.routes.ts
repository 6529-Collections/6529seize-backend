import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import * as Joi from 'joi';
import { RateMatterTargetType } from '../../../entities/IRateMatter';
import {
  getWalletOrNull,
  getWalletOrThrow,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '../auth/auth';
import { WALLET_REGEX } from '../../../constants';
import { ForbiddenException } from '../../../exceptions';
import { asyncRouter } from '../async.router';
import { getValidatedByJoiOrThrow } from '../validation';
import { Logger } from '../../../logging';
import { RateCategoryInfo } from '../../../rates/rates.types';
import { ratesService } from '../../../rates/rates.service';
import * as profiles from '../../../profiles/profiles';

const router = asyncRouter();

const logger = Logger.get('RATES_API');

router.get(
  `/targets/:matter_target_type/:matter_target_id/matters/:matter`,
  maybeAuthenticatedUser(),
  async function (
    req: Request<
      {
        matter_target_id: string;
        matter_target_type: RateMatterTargetType;
        matter: string;
      },
      any,
      any,
      any,
      any
    >,
    res: Response<ApiResponse<WalletStateOnMattersRating>>
  ) {
    const { matter, matter_target_type, matter_target_id } = req.params;
    const wallet = getWalletOrNull(req);
    const profileId = wallet
      ? await profiles.getProfileIdByWallet(wallet)
      : null;
    const categoriesInfo = await ratesService.getCategoriesInfoOnMatter({
      profileId,
      matter,
      matterTargetType: matter_target_type,
      matterTargetId: matter_target_id
    });
    const profilePrimaryWallet = profileId
      ? await profiles.getPrimaryWalletByProfileId(profileId)
      : null;
    const ratesLeft = profilePrimaryWallet
      ? await ratesService
          .getRatesLeftOnMatterForProfile({
            profileId: profileId!,
            matter,
            matterTargetType: matter_target_type
          })
          .then((it) => it?.ratesLeft)
      : 0;
    res.status(200).send({
      rates_left: ratesLeft,
      categories: categoriesInfo
    });
  }
);

router.post(
  `/targets/:matter_target_type/:matter_target_id/matters/:matter`,
  needsAuthenticatedUser(),
  async function (
    req: Request<
      {
        matter_target_id: string;
        matter_target_type: RateMatterTargetType;
        matter: string;
      },
      any,
      any,
      any,
      any
    >,
    res: Response<ApiResponse<void>>
  ) {
    const walletFromHeader = getWalletOrThrow(req);
    const { matter, matter_target_type, matter_target_id } = req.params;
    const { amount, category, rater_wallet } = req.body as ApiRateRequestBody;
    if (walletFromHeader !== rater_wallet) {
      logger.error(
        `Rater failed to rate on path (target_type=${matter_target_type}; matter=${matter}; category=${category}}) because wallet from auth '${walletFromHeader}' and wallet in body '${rater_wallet}' did not match`
      );
      throw new ForbiddenException(
        'Something went wrong. User is not allowed to rate.'
      );
    }
    const rateRequest = getValidatedByJoiOrThrow(
      {
        raterWallet: rater_wallet,
        matter,
        matterTargetType: matter_target_type,
        matterTargetId: matter_target_id,
        category: category,
        amount: amount
      },
      WalletRateRequestSchema
    );
    await ratesService.registerUserRatingWithWallet(rateRequest);
    res.status(201).send();
  }
);

interface ApiRateRequestBody {
  rater_wallet: string;
  amount: number;
  category: string;
}

const WalletRateRequestSchema = Joi.object<{
  raterWallet: string;
  matter: string;
  matterTargetType: RateMatterTargetType;
  matterTargetId: string;
  category: string;
  amount: number;
}>({
  raterWallet: Joi.string().regex(WALLET_REGEX).required(),
  matterTargetType: Joi.string()
    .valid(...Object.values(RateMatterTargetType))
    .required(),
  matter: Joi.string()
    .when('matterTargetType', {
      is: RateMatterTargetType.PROFILE_ID,
      then: Joi.string().equal('CIC').required()
    })
    .required(),
  matterTargetId: Joi.string()
    .when('matterTargetType', {
      is: RateMatterTargetType.WALLET,
      then: Joi.string().regex(WALLET_REGEX).required()
    })
    .required(),
  category: Joi.string().required(),
  amount: Joi.number().integer().options({ convert: false })
});

export interface WalletStateOnMattersRating {
  rates_left: number;
  categories: RateCategoryInfo[];
}

export default router;
