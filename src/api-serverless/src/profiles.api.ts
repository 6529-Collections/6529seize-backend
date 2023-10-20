import { Router, Request, Response } from 'express';
import { ApiResponse, INTERNAL_SERVER_ERROR } from './api-response';
import { getWalletOrNull, needsAuthenticatedUser } from './auth';
import * as Joi from 'joi';
import { PROFILE_HANDLE_REGEX, WALLET_REGEX } from '../../constants';
import { getValidatedByJoiOrThrow } from './validation';
import {
  CreateOrUpdateProfileCommand,
  ProfileAndConsolidations
} from '../../profiles';
import * as profiles from '../../profiles';
import { BadRequestException } from '../../bad-request.exception';
import * as multer from 'multer';

const router = Router();
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

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
    try {
      const handleOrWallet = req.params.handleOrWallet.toLowerCase();
      await profiles
        .getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(handleOrWallet)
        .then((profileAndConsolidations) => {
          if (profileAndConsolidations) {
            res.status(200).send(profileAndConsolidations);
          } else {
            res.status(404).send({
              error: 'Profile not found'
            });
          }
        });
    } catch (err) {
      res.status(500).send(INTERNAL_SERVER_ERROR);
      throw err;
    } finally {
      res.end();
    }
  }
);

router.post(
  `/`,
  needsAuthenticatedUser(),
  async function (
    req: Request<any, any, ApiCreateOrUpdateProfileRequest, any, any>,
    res: Response<ApiResponse<ProfileAndConsolidations>>
  ) {
    try {
      const { handle, primary_wallet, banner_1, banner_2, website } =
        getValidatedByJoiOrThrow(
          req.body,
          ApiCreateOrUpdateProfileRequestSchema
        );
      const createProfileCommand: CreateOrUpdateProfileCommand = {
        handle,
        primary_wallet: primary_wallet.toLowerCase(),
        banner_1,
        banner_2,
        website,
        creator_or_updater_wallet: getWalletOrNull(req)!
      };
      const profile = await profiles.createOrUpdateProfile(
        createProfileCommand
      );
      res.status(201).send(profile);
    } catch (err) {
      if (err instanceof BadRequestException) {
        res.status(400).send({
          error: err.message
        });
      } else {
        res.status(500).send(INTERNAL_SERVER_ERROR);
        throw err;
      }
    } finally {
      res.end();
    }
  }
);

router.post(
  `/:handleOrWallet/pfp`,
  needsAuthenticatedUser(),
  upload.single('pfp'),
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
    try {
      const authenticatedWallet = getWalletOrNull(req);
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
    } catch (err) {
      if (err instanceof BadRequestException) {
        res.status(400).send({
          error: err.message
        });
      } else {
        res.status(500).send(INTERNAL_SERVER_ERROR);
        throw err;
      }
    } finally {
      res.end();
    }
  }
);

interface ApiCreateOrUpdateProfileRequest {
  readonly handle: string;
  readonly primary_wallet: string;
  readonly banner_1?: string;
  readonly banner_2?: string;
  readonly website?: string;
}

const ApiCreateOrUpdateProfileRequestSchema: Joi.ObjectSchema<ApiCreateOrUpdateProfileRequest> =
  Joi.object({
    handle: Joi.string().min(3).max(15).regex(PROFILE_HANDLE_REGEX).required(),
    primary_wallet: Joi.string().regex(WALLET_REGEX).required(),
    banner_1: Joi.string().optional(),
    banner_2: Joi.string().optional(),
    website: Joi.string().uri().optional()
  });

interface ApiUploadProfilePictureRequest {
  readonly meme?: number;
  readonly file?: Express.Multer.File;
}

const ApiUploadProfilePictureRequestSchema: Joi.ObjectSchema<ApiUploadProfilePictureRequest> =
  Joi.object({
    meme: Joi.number().optional()
  });

export default router;
