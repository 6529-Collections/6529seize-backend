import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import {
  getAuthenticatedWalletOrNull,
  getWalletOrThrow,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '../auth/auth';
import * as Joi from 'joi';
import { PROFILE_HANDLE_REGEX } from '@/constants';
import { getValidatedByJoiOrThrow } from '../validation';
import { NotFoundException } from '../../../exceptions';
import { initMulterSingleMiddleware } from '../multer-middleware';

import { asyncRouter } from '../async.router';
import { RESERVED_HANDLES } from './profiles.constants';
import { ProfileClassification } from '../../../entities/IProfile';
import {
  CreateOrUpdateProfileCommand,
  ProfileAndConsolidations
} from '../../../profiles/profile.types';
import { profilesService } from '../../../profiles/profiles.service';
import profileCicRoutes from './profile-cic.routes';
import profileRepRoutes from './profile-rep.routes';
import profileCollectedRoutes from './collected/collected.routes';
import profilePrimaryAddressRoutes from './profile-primary-address.routes';
import profileProfileProxiesRoutes from './proxies/profile-proxies.routes';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { getProfileClassificationsBySubclassification } from './profile.helper';
import { ApiIdentity } from '../generated/models/ApiIdentity';
import { ApiCreateOrUpdateProfileRequest } from '../generated/models/ApiCreateOrUpdateProfileRequest';
import { ApiProfileClassification } from '../generated/models/ApiProfileClassification';
import { identitiesService } from '../identities/identities.service';
import { identityFetcher } from '../identities/identity.fetcher';
import { Timer } from '../../../time';
import { enums } from '../../../enums';

const router = asyncRouter();

router.get(
  `/:identity`,
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
    res: Response<ApiResponse<ProfileAndConsolidations>>
  ) {
    const identity = req.params.identity.toLowerCase();
    const profile =
      await profilesService.getProfileAndConsolidationsByIdentity(identity);
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
    const maybeAuthenticatedWallet = getAuthenticatedWalletOrNull(req);
    const timer = Timer.getFromRequest(req);
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
          await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
            {
              identityKey: maybeAuthenticatedWallet
            },
            { timer }
          )
        )?.handle
      : null;
    if (proposedHandle.toLowerCase() !== authenticatedHandle?.toLowerCase()) {
      const profile =
        await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
          {
            identityKey: proposedHandle
          },
          { timer }
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
    res: Response<ApiResponse<ApiIdentity>>
  ) {
    const {
      handle,
      banner_1,
      banner_2,
      website,
      classification,
      sub_classification,
      pfp_url
    } = getValidatedByJoiOrThrow(
      req.body,
      ApiCreateOrUpdateProfileRequestSchema
    );
    let subClassification = sub_classification;
    if (subClassification !== null) {
      const classifications =
        enums.resolve(
          ProfileClassification,
          getProfileClassificationsBySubclassification(
            subClassification
          ).toString()
        ) ?? ProfileClassification.PSEUDONYM;
      if (!classifications.includes(classification)) {
        subClassification = null;
      }
    }
    const createProfileCommand: CreateOrUpdateProfileCommand = {
      handle,
      banner_1,
      banner_2,
      website,
      creator_or_updater_wallet: getWalletOrThrow(req),
      classification:
        enums.resolve(ProfileClassification, classification.toString()) ??
        ProfileClassification.PSEUDONYM,
      sub_classification: subClassification,
      pfp_url
    };
    const profile =
      await profilesService.createOrUpdateProfile(createProfileCommand);
    await giveReadReplicaTimeToCatchUp();
    res.status(201).send(profile);
  }
);

router.post(
  `/:identity/pfp`,
  needsAuthenticatedUser(),
  initMulterSingleMiddleware('pfp'),
  async function (
    req: Request<
      {
        identity: string;
      },
      any,
      ApiUploadProfilePictureRequest,
      any,
      any
    >,
    res: Response<ApiResponse<{ pfp_url: string }>>
  ) {
    const authenticatedWallet = getWalletOrThrow(req);
    const identity = req.params.identity.toLowerCase();
    const { meme } = getValidatedByJoiOrThrow(
      req.body,
      ApiUploadProfilePictureRequestSchema
    );
    const file = req.file;
    const response = await identitiesService.updateProfilePfp({
      authenticatedWallet,
      identity,
      memeOrFile: { file, meme }
    });
    await giveReadReplicaTimeToCatchUp();
    res.status(201).send(response);
  }
);

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
    banner_1: Joi.string().optional(),
    banner_2: Joi.string().optional(),
    website: Joi.string().uri().optional().messages({
      'string.uri': `Please enter a valid website link, starting with 'http://' or 'https://'.`
    }),
    classification: Joi.string()
      .valid(...Object.values(ApiProfileClassification))
      .required(),
    sub_classification: Joi.string().optional().allow(null).default(null),
    pfp_url: Joi.string()
      .optional()
      .regex(/^(?:ipfs:\/\/|https:\/\/d3lqz0a4bldqgf).+$/)
      .allow(null)
      .default(null)
  });

interface ApiUploadProfilePictureRequest {
  readonly meme?: number;
  readonly file?: Express.Multer.File;
}

const ApiUploadProfilePictureRequestSchema: Joi.ObjectSchema<ApiUploadProfilePictureRequest> =
  Joi.object({
    meme: Joi.number().optional()
  });

router.use('/:identity/cic', profileCicRoutes);
router.use('/:identity/rep', profileRepRoutes);
router.use('/:identity/collected', profileCollectedRoutes);
router.use('/:identity/primary-address', profilePrimaryAddressRoutes);
router.use('/:identity/proxies', profileProfileProxiesRoutes);

export default router;
