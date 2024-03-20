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
import { BadRequestException, ForbiddenException } from '../../../exceptions';
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

const router = asyncRouter();

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
      .getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
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
      storm_id: newDrop.storm_id,
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
  storm_id: Joi.number().integer().default(null),
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
