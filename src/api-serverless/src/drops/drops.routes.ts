import { asyncRouter } from '../async.router';
import { getWalletOrThrow, needsAuthenticatedUser } from '../auth/auth';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import * as Joi from 'joi';
import {
  DropApiRawRequest,
  DropApiRequest,
  fromRawApiRequestToApiRequest
} from './drops.api.types';
import { getValidatedByJoiOrThrow } from '../validation';
import { profilesService } from '../../../profiles/profiles.service';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../../../exceptions';
import { initMulterSingleMiddleware } from '../multer-middleware';
import { dropCreationService } from '../../../drops/drop-creation.service';
import {
  CreateNewDropRequest,
  DropFull,
  DropMentionedUser,
  DropReferencedNft,
  NewDropMedia
} from '../../../drops/drops.types';
import { DropMetadataEntity } from '../../../entities/IDrop';
import { WALLET_REGEX } from '../../../constants';
import { dropsService } from '../../../drops/drops.service';
import { parseIntOrNull, parseNumberOrNull } from '../../../helpers';
import { abusivenessCheckService } from '../../../profiles/abusiveness-check.service';
import { REP_CATEGORY_PATTERN } from '../../../entities/IAbusivenessDetectionResult';

const router = asyncRouter();

router.get(
  '/',
  async (
    req: Request<
      any,
      any,
      any,
      {
        limit: number;
        curation_criteria_id?: string;
        id_less_than?: number;
        root_drop_id?: number;
      },
      any
    >,
    res: Response<ApiResponse<DropFull[]>>
  ) => {
    const limit = parseNumberOrNull(req.query.limit) ?? 10;
    const curation_criteria_id = req.query.curation_criteria_id ?? null;
    const root_drop_id = parseIntOrNull(req.query.root_drop_id);
    const createdDrop = await dropsService.findLatestDrops({
      amount: limit < 0 || limit > 200 ? 10 : limit,
      curation_criteria_id,
      id_less_than: parseNumberOrNull(req.query.id_less_than),
      root_drop_id
    });
    res.send(createdDrop);
  }
);

router.get(
  '/:drop_id',
  async (
    req: Request<{ drop_id: number }, any, any, any, any>,
    res: Response<ApiResponse<DropFull>>
  ) => {
    const dropId = parseNumberOrNull(req.params.drop_id);
    if (!dropId) {
      throw new NotFoundException(`Drop ${req.params.drop_id} not found`);
    }
    const drop = await dropsService.findDropByIdOrThrow(dropId);
    res.send(drop);
  }
);

router.post(
  '/',
  needsAuthenticatedUser(),
  initMulterSingleMiddleware('drop_media'),
  async (
    req: Request<any, any, DropApiRawRequest, any, any>,
    res: Response<ApiResponse<DropFull>>
  ) => {
    const postMedia = convertToMediaOrNull(req.file);
    const apiRequest = fromRawApiRequestToApiRequest(req.body);
    const newDrop: DropApiRequest = getValidatedByJoiOrThrow(
      apiRequest,
      NewDropSchema
    );
    if (!newDrop.content && !postMedia) {
      throw new BadRequestException(
        'You need to provide either content or media'
      );
    }
    const authorProfile = await profilesService
      .getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        getWalletOrThrow(req)
      )
      ?.then((result) => result?.profile ?? null);
    if (!authorProfile) {
      throw new ForbiddenException(
        'You need to create a profile before you can create a drop'
      );
    }
    const createDropRequest: CreateNewDropRequest = {
      author: authorProfile,
      title: newDrop.title,
      content: newDrop.content,
      root_drop_id: newDrop.root_drop_id,
      quoted_drop_id: newDrop.quoted_drop_id,
      referenced_nfts: newDrop.referenced_nfts,
      mentioned_users: newDrop.mentioned_users,
      metadata: newDrop.metadata,
      dropMedia: postMedia
    };
    const createdDrop = await dropCreationService.createDrop(createDropRequest);
    res.send(createdDrop);
  }
);

router.post(
  `/:drop_id/rep`,
  needsAuthenticatedUser(),
  async function (
    req: Request<
      { drop_id: string },
      any,
      ApiAddRepRatingToDropRequest,
      any,
      any
    >,
    res: Response<ApiResponse<DropFull>>
  ) {
    const { amount, category } = getValidatedByJoiOrThrow(
      req.body,
      ApiAddRepRatingToDropRequestSchema
    );
    const proposedCategory = category?.trim() ?? '';
    const raterWallet = getWalletOrThrow(req);
    const raterProfileId = await profilesService
      .getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(raterWallet)
      ?.then((result) => result?.profile?.external_id ?? null);
    if (!raterProfileId) {
      throw new ForbiddenException(
        `No profile found for authenticated user ${raterWallet}`
      );
    }
    const dropId = req.params.drop_id;
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
    const response = await dropsService.updateRatingAndGetDrop({
      rater_profile_id: raterProfileId,
      category: proposedCategory,
      drop_id: dropId,
      rating: amount
    });
    res.send(response);
  }
);

interface ApiAddRepRatingToDropRequest {
  readonly amount: number;
  readonly category: string;
}

const ApiAddRepRatingToDropRequestSchema: Joi.ObjectSchema<ApiAddRepRatingToDropRequest> =
  Joi.object({
    amount: Joi.number().integer().required(),
    category: Joi.string().max(100).regex(REP_CATEGORY_PATTERN).messages({
      'string.pattern.base': `Invalid category. Category can't be longer than 100 characters. It can only alphanumeric characters, spaces, commas, punctuation, parentheses and single quotes.`
    })
  });

const NftSchema: Joi.ObjectSchema<DropReferencedNft> = Joi.object({
  contract: Joi.string().regex(WALLET_REGEX).lowercase(),
  token: Joi.string().regex(/^\d+$/),
  name: Joi.string().min(1)
});

const MentionedUserSchema: Joi.ObjectSchema<DropMentionedUser> = Joi.object({
  mentioned_profile_id: Joi.string().min(1).max(100).required(),
  handle_in_content: Joi.string().min(1).max(100).required()
});

const MetadataSchema: Joi.ObjectSchema<DropMetadataEntity> = Joi.object({
  data_key: Joi.string().min(1).max(100).required(),
  data_value: Joi.string().min(1).max(500).required()
});

const NewDropSchema: Joi.ObjectSchema<DropApiRequest> = Joi.object({
  title: Joi.string().optional().max(250).default(null),
  content: Joi.string().optional().max(25000).default(null),
  quoted_drop_id: Joi.number().integer().default(null),
  root_drop_id: Joi.number().integer().default(null),
  referenced_nfts: Joi.array().optional().items(NftSchema).default([]),
  mentioned_users: Joi.array()
    .optional()
    .items(MentionedUserSchema)
    .default([]),
  metadata: Joi.array().optional().items(MetadataSchema).default([])
});

function convertToMediaOrNull(
  postMedia?: Express.Multer.File
): NewDropMedia | null {
  if (!postMedia) {
    return null;
  }
  return {
    stream: postMedia.buffer,
    name: postMedia.originalname,
    mimetype: postMedia.mimetype,
    size: postMedia.size
  };
}

export default router;
