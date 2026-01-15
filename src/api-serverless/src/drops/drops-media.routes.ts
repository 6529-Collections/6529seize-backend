import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import {
  getAuthenticatedProfileIdOrNull,
  needsAuthenticatedUser
} from '../auth/auth';
import { ForbiddenException } from '../../../exceptions';
import { uploadMediaService } from '../media/upload-media.service';
import { getValidatedByJoiOrThrow } from '../validation';
import { ApiCreateMediaUrlResponse } from '../generated/models/ApiCreateMediaUrlResponse';
import { ApiCreateMediaUploadUrlRequest } from '../generated/models/ApiCreateMediaUploadUrlRequest';
import { ApiStartMultipartMediaUploadResponse } from '../generated/models/ApiStartMultipartMediaUploadResponse';
import { ApiUploadPartOfMultipartUploadRequest } from '../generated/models/ApiUploadPartOfMultipartUploadRequest';
import { ApiUploadPartOfMultipartUploadResponse } from '../generated/models/ApiUploadPartOfMultipartUploadResponse';
import { ApiCompleteMultipartUploadRequest } from '../generated/models/ApiCompleteMultipartUploadRequest';
import { ApiCompleteMultipartUploadResponse } from '../generated/models/ApiCompleteMultipartUploadResponse';
import {
  ApiCompleteMultipartUploadRequestSchema,
  ApiUploadPartOfMultipartUploadRequestSchema,
  createMediaPrepRequestSchema
} from '../media/media-uplodad.validators';

const router = asyncRouter();

router.post(
  '/prep',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiCreateMediaUploadUrlRequest, any, any>,
    res: Response<ApiResponse<ApiCreateMediaUrlResponse>>
  ) => {
    const authenticatedProfileId = await getAuthenticatedProfileIdOrNull(req);
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const validatedRequest: ApiCreateMediaUploadUrlRequest & {
      author: string;
    } = getValidatedByJoiOrThrow(
      {
        content_type: req.body.content_type,
        file_name: req.body.file_name,
        author: authenticatedProfileId
      },
      MediaPrepRequestSchema
    );
    const response = await uploadMediaService.createSingedDropMediaUploadUrl({
      content_type: validatedRequest.content_type,
      author_id: validatedRequest.author,
      file_name: validatedRequest.file_name
    });
    res.send(response);
  }
);

router.post(
  '/multipart-upload',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiCreateMediaUploadUrlRequest, any, any>,
    res: Response<ApiResponse<ApiStartMultipartMediaUploadResponse>>
  ) => {
    const authenticatedProfileId = await getAuthenticatedProfileIdOrNull(req);
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const validatedRequest: ApiCreateMediaUploadUrlRequest & {
      author: string;
    } = getValidatedByJoiOrThrow(
      {
        ...req.body,
        author: authenticatedProfileId
      },
      MediaPrepRequestSchema
    );

    const { key, upload_id } =
      await uploadMediaService.getDropMediaMultipartUploadKeyAndUploadId({
        content_type: validatedRequest.content_type,
        author_id: validatedRequest.author,
        file_name: validatedRequest.file_name
      });

    res.send({
      upload_id,
      key
    });
  }
);

router.post(
  '/multipart-upload/part',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiUploadPartOfMultipartUploadRequest, any, any>,
    res: Response<ApiResponse<ApiUploadPartOfMultipartUploadResponse>>
  ) => {
    const validatedRequest = getValidatedByJoiOrThrow(
      req.body,
      ApiUploadPartOfMultipartUploadRequestSchema
    );

    const url =
      await uploadMediaService.getSignedUrlForPartOfMultipartUpload(
        validatedRequest
      );

    res.send({
      upload_url: url
    });
  }
);

router.post(
  '/multipart-upload/completion',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiCompleteMultipartUploadRequest, any, any>,
    res: Response<ApiResponse<ApiCompleteMultipartUploadResponse>>
  ) => {
    const validatedRequest = getValidatedByJoiOrThrow(
      req.body,
      ApiCompleteMultipartUploadRequestSchema
    );
    const url =
      await uploadMediaService.completeMultipartUpload(validatedRequest);
    res.send({
      media_url: url
    });
  }
);

const MediaPrepRequestSchema = createMediaPrepRequestSchema({
  allowedMimeTypes: [
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
    'model/gltf-binary',
    'video/quicktime'
  ]
});

export default router;
