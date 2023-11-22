import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import {
  getWalletOrNull,
  getWalletOrThrow,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '../auth/auth';
import * as Joi from 'joi';
import { PROFILE_HANDLE_REGEX, WALLET_REGEX } from '../../../constants';
import { getValidatedByJoiOrThrow } from '../validation';
import {
  CreateOrUpdateProfileCommand,
  ProfileAndConsolidations
} from '../../../profiles/profiles';
import * as rates from '../../../rates';
import * as profiles from '../../../profiles/profiles';
import { NotFoundException } from '../../../exceptions';
import { initMulterSingleMiddleware } from '../multer-middleware';

import { asyncRouter } from '../async.router';
import { RESERVED_HANDLES } from './profiles.constats';
import { ProfileClassification } from '../../../entities/IProfile';
import { RateMatterTargetType } from '../../../entities/IRateMatter';

const router = asyncRouter();

router.get(
  `/:handleOrWallet`,
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
    res: Response<ApiResponse<ProfileAndConsolidations>>
  ) {
    const handleOrWallet = req.params.handleOrWallet.toLowerCase();
    const profile =
      await profiles.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        handleOrWallet
      );
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    res.status(200).send(profile);
  }
);

router.get(
  `/:handle/availability`,
  maybeAuthenticatedUser(),
  async function (
    req: Request<
      {
        handle: string;
      },
      any,
      any,
      any,
      any
    >,
    res: Response<ApiResponse<{ available: boolean; message: string }>>
  ) {
    const maybeAuthenticatedWallet = getWalletOrNull(req);
    const proposedHandle = req.params.handle.toLowerCase();
    if (!proposedHandle.match(PROFILE_HANDLE_REGEX)) {
      return res.status(200).send({
        available: false,
        message: `Invalid username. Use 3-15 letters, numbers, or underscores.`
      });
    }
    if (
      RESERVED_HANDLES.map((h) => h.toLowerCase()).includes(
        proposedHandle.toLowerCase()
      )
    ) {
      return res.status(200).send({
        available: false,
        message: `This username is not available. Please choose a different one.`
      });
    }
    const authenticatedHandle = maybeAuthenticatedWallet
      ? (
          await profiles.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
            maybeAuthenticatedWallet
          )
        )?.profile?.handle
      : null;
    if (proposedHandle.toLowerCase() !== authenticatedHandle?.toLowerCase()) {
      const profile =
        await profiles.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
          proposedHandle
        );
      if (profile) {
        return res.status(200).send({
          available: false,
          message: `This username is not available. Please choose a different one.`
        });
      }
    }
    res.status(200).send({
      available: true,
      message: 'Username is available.'
    });
  }
);

router.post(
  `/`,
  needsAuthenticatedUser(),
  async function (
    req: Request<any, any, ApiCreateOrUpdateProfileRequest, any, any>,
    res: Response<ApiResponse<ProfileAndConsolidations>>
  ) {
    const {
      handle,
      primary_wallet,
      banner_1,
      banner_2,
      website,
      classification
    } = getValidatedByJoiOrThrow(
      req.body,
      ApiCreateOrUpdateProfileRequestSchema
    );
    const createProfileCommand: CreateOrUpdateProfileCommand = {
      handle,
      primary_wallet: primary_wallet.toLowerCase(),
      banner_1,
      banner_2,
      website,
      creator_or_updater_wallet: getWalletOrThrow(req),
      classification
    };
    const profile = await profiles.createOrUpdateProfile(createProfileCommand);
    res.status(201).send(profile);
  }
);

router.post(
  `/:handleOrWallet/pfp`,
  needsAuthenticatedUser(),
  initMulterSingleMiddleware('pfp'),
  async function (
    req: Request<
      {
        handleOrWallet: string;
      },
      any,
      ApiUploadProfilePictureRequest,
      any,
      any
    >,
    res: Response<ApiResponse<{ pfp_url: string }>>
  ) {
    const authenticatedWallet = getWalletOrThrow(req);
    const handleOrWallet = req.params.handleOrWallet.toLowerCase();
    const { meme } = getValidatedByJoiOrThrow(
      req.body,
      ApiUploadProfilePictureRequestSchema
    );
    const file = req.file;
    const response = await profiles.updateProfilePfp({
      authenticatedWallet,
      handleOrWallet,
      memeOrFile: { file, meme }
    });
    res.status(201).send(response);
  }
);

router.post(
  `/:handleOrWallet/cic/rating`,
  needsAuthenticatedUser(),
  async function (
    req: Request<
      {
        handleOrWallet: string;
      },
      any,
      ApiAddCicRatingToProfileRequest,
      any,
      any
    >,
    res: Response<ApiResponse<ProfileAndConsolidations>>
  ) {
    const handleOrWallet = req.params.handleOrWallet.toLowerCase();
    const raterWallet = getWalletOrThrow(req);
    const { amount } = getValidatedByJoiOrThrow(
      req.body,
      ApiAddCicRatingToProfileRequestSchema
    );
    const profile =
      await profiles.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        handleOrWallet
      );
    if (!profile?.profile) {
      throw new NotFoundException(`No profile found for ${handleOrWallet}`);
    }
    await rates.registerUserRating({
      rater: raterWallet.toLowerCase(),
      matterTargetType: RateMatterTargetType.PROFILE_ID,
      matterTargetId: profile.profile.external_id,
      matter: 'CIC',
      category: 'CIC',
      amount
    });
    const updatedProfileInfo =
      await profiles.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
        handleOrWallet
      );
    res.status(201).send(updatedProfileInfo!);
  }
);

interface ApiCreateOrUpdateProfileRequest {
  readonly handle: string;
  readonly primary_wallet: string;
  readonly banner_1?: string;
  readonly banner_2?: string;
  readonly website?: string;
  readonly classification: ProfileClassification;
}

const ApiCreateOrUpdateProfileRequestSchema: Joi.ObjectSchema<ApiCreateOrUpdateProfileRequest> =
  Joi.object({
    handle: Joi.string()
      .min(3)
      .max(15)
      .regex(PROFILE_HANDLE_REGEX)
      .custom((value, helpers) => {
        const lowerCaseValue = value.toLowerCase();
        if (
          RESERVED_HANDLES.map((h) => h.toLowerCase()).includes(lowerCaseValue)
        ) {
          return helpers.message({
            custom: `This username is not available. Please choose a different one.`
          });
        }
        return value;
      })
      .required()
      .messages({
        'string.pattern.base': `Invalid username. Use 3-15 letters, numbers, or underscores.`
      }),
    primary_wallet: Joi.string().regex(WALLET_REGEX).required(),
    banner_1: Joi.string().optional(),
    banner_2: Joi.string().optional(),
    website: Joi.string().uri().optional().messages({
      'string.uri': `Please enter a valid website link, starting with 'http://' or 'https://'.`
    }),
    classification: Joi.string()
      .valid(...Object.values(ProfileClassification))
      .required()
  });

interface ApiUploadProfilePictureRequest {
  readonly meme?: number;
  readonly file?: Express.Multer.File;
}

const ApiUploadProfilePictureRequestSchema: Joi.ObjectSchema<ApiUploadProfilePictureRequest> =
  Joi.object({
    meme: Joi.number().optional()
  });

interface ApiAddCicRatingToProfileRequest {
  readonly amount: number;
}

const ApiAddCicRatingToProfileRequestSchema: Joi.ObjectSchema<ApiAddCicRatingToProfileRequest> =
  Joi.object({
    amount: Joi.number().integer().required()
  });

export default router;
