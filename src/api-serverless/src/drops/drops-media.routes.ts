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
  CreateMediaUploadUrlResponse,
  dropFileService
} from '../../../drops/drop-file.service';
import { getValidatedByJoiOrThrow } from '../validation';
import * as Joi from 'joi';

const router = asyncRouter();

router.post(
  '/prep',
  needsAuthenticatedUser(),
  async (
    req: Request<
      any,
      any,
      Omit<CreateMediaUploadUrlRequest, 'author_id'>,
      any,
      any
    >,
    res: Response<ApiResponse<CreateMediaUploadUrlResponse>>
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
    content_type: Joi.string().required(),
    file_name: Joi.string().required()
  });

export default router;
