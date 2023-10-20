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

const router = Router();

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
      const {
        handle,
        primary_wallet,
        pfp_url,
        banner_1_url,
        banner_2_url,
        website
      } = getValidatedByJoiOrThrow(
        req.body,
        ApiCreateOrUpdateProfileRequestSchema
      );
      const createProfileCommand: CreateOrUpdateProfileCommand = {
        handle,
        primary_wallet: primary_wallet.toLowerCase(),
        pfp_url,
        banner_1_url,
        banner_2_url,
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

interface ApiCreateOrUpdateProfileRequest {
  readonly handle: string;
  readonly primary_wallet: string;
  readonly pfp_url?: string;
  readonly banner_1_url?: string;
  readonly banner_2_url?: string;
  readonly website?: string;
}

const ApiCreateOrUpdateProfileRequestSchema: Joi.ObjectSchema<ApiCreateOrUpdateProfileRequest> =
  Joi.object({
    handle: Joi.string().min(3).max(15).regex(PROFILE_HANDLE_REGEX).required(),
    primary_wallet: Joi.string().regex(WALLET_REGEX).required(),
    pfp_url: Joi.string().uri().optional(),
    banner_1_url: Joi.string().uri().optional(),
    banner_2_url: Joi.string().uri().optional(),
    website: Joi.string().uri().optional()
  });

export default router;
