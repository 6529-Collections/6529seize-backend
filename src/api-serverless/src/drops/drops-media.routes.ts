import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import {
  getAuthenticatedProfileIdOrNull,
  needsAuthenticatedUser
} from '../auth/auth';
import { ForbiddenException } from '../../../exceptions';
import {
  CreateMediaUploadUrlRequest,
  dropFileService
} from './drop-file.service';
import { getValidatedByJoiOrThrow } from '../validation';
import * as Joi from 'joi';
import { CreateDropMediaUrl201Response } from '../generated/models/CreateDropMediaUrl201Response';
import { CreateDropMediaUrlRequest } from '../generated/models/CreateDropMediaUrlRequest';

const router = asyncRouter();

router.post(
  '/prep',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, CreateDropMediaUrlRequest, any, any>,
    res: Response<ApiResponse<CreateDropMediaUrl201Response>>
  ) => {
    const authenticatedProfileId = await getAuthenticatedProfileIdOrNull(req);
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const createMediaUploadUrlRequest: CreateMediaUploadUrlRequest =
      getValidatedByJoiOrThrow(
        {
          ...req.body,
          author_id: authenticatedProfileId
        },
        MediaPrepRequestSchema
      );
    const response = await dropFileService.createSingedDropMediaUploadUrl(
      createMediaUploadUrlRequest
    );
    res.send(response);
  }
);

const MediaPrepRequestSchema: Joi.ObjectSchema<CreateMediaUploadUrlRequest> =
  Joi.object({
    author_id: Joi.string().required(),
    content_type: Joi.string()
      .required()
      .allow(
        ...[
          'image/png',
          'image/jpeg',
          'image/gif',
          'video/mp4',
          'video/x-msvideo',
          'audio/mpeg',
          'audio/mpeg3',
          'audio/ogg',
          'audio/mp3',
          'audio/wav',
          'audio/aac',
          'audio/x-aac',
          'model/gltf-binary'
        ]
      ),
    file_name: Joi.string().required(),
    file_size: Joi.number().integer().required().min(1).max(500000000) // 500MB
  });

export default router;
