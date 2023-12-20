import { asyncRouter } from '../async.router';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { ProfileAndConsolidations } from '../../../profiles/profile.types';
import { getValidatedByJoiOrThrow } from '../validation';
import { profilesService } from '../../../profiles/profiles.service';
import { BadRequestException, NotFoundException } from '../../../exceptions';
import * as Joi from 'joi';
import { ratingsService } from '../../../rates/ratings.service';
import { RateMatter } from '../../../entities/IRating';
import { REP_CATEGORY_PATTERN } from '../../../entities/IAbusivenessDetectionResult';
import { abusivenessCheckService } from '../../../profiles/abusiveness-check.service';

const router = asyncRouter({ mergeParams: true });

router.post(
  `/rating`,
  needsAuthenticatedUser(),
  async function (
    req: Request<
      {
        handleOrWallet: string;
      },
      any,
      ApiAddRepRatingToProfileRequest,
      any,
      any
    >,
    res: Response<ApiResponse<ProfileAndConsolidations>>
  ) {
    const handleOrWallet = req.params.handleOrWallet.toLowerCase();
    const raterWallet = getWalletOrThrow(req);
    const { amount, category } = getValidatedByJoiOrThrow(
      req.body,
      ApiAddRepRatingToProfileRequestSchema
    );
    const proposedCategory = category?.trim() ?? '';
    const targetProfile =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        handleOrWallet
      );
    if (!targetProfile?.profile) {
      throw new NotFoundException(`No profile found for ${handleOrWallet}`);
    }
    const raterProfile =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        raterWallet
      );
    if (!raterProfile?.profile) {
      throw new NotFoundException(
        `No profile found for authenticated used ${handleOrWallet}`
      );
    }
    const raterProfileId = raterProfile.profile.external_id;
    const targetProfileId = targetProfile.profile.external_id;
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
    const updatedProfileInfo =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        handleOrWallet
      );
    res.status(201).send(updatedProfileInfo!);
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
