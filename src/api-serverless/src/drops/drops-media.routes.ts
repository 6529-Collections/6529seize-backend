import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import {
  getAuthenticatedProfileIdOrNull,
  needsAuthenticatedUser
} from '../auth/auth';
import { ForbiddenException } from '../../../exceptions';
import { NotFoundException } from '@/exceptions';
import { uploadMediaService } from '../media/upload-media.service';
import { dropMediaUploadsDb } from '@/drops/drop-media-uploads.db';
import { ApiDropMediaStatus } from '@/api/generated/models/ApiDropMediaStatus';
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
import {
  DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE,
  DROP_MEDIA_ALLOWED_MIME_TYPES
} from '@/api/media/media-mime-types';

const router = asyncRouter();

router.get(
  '/uploads/:media_upload_id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ media_upload_id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiCompleteMultipartUploadResponse>>
  ) => {
    const authenticatedProfileId = await getAuthenticatedProfileIdOrNull(req);
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const upload = await dropMediaUploadsDb.findById(
      req.params.media_upload_id
    );
    if (!upload) {
      throw new NotFoundException('Media upload not found');
    }
    if (upload.profile_id !== authenticatedProfileId) {
      throw new ForbiddenException('Cannot read this media upload');
    }
    res.send({
      media_url: upload.public_url,
      media_upload_id: upload.id,
      media_status: mapDropMediaStatus(upload.status),
      media_error: upload.error_reason
    });
  }
);

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
    const validatedRequest = getValidatedByJoiOrThrow(
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
    const validatedRequest = getValidatedByJoiOrThrow(
      {
        ...req.body,
        author: authenticatedProfileId
      },
      MediaPrepRequestSchema
    );

    const response =
      await uploadMediaService.getDropMediaMultipartUploadKeyAndUploadId({
        content_type: validatedRequest.content_type,
        author_id: validatedRequest.author,
        file_name: validatedRequest.file_name
      });

    res.send(response);
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
    const response =
      await uploadMediaService.completeMultipartUpload(validatedRequest);
    res.send(response);
  }
);

const MediaPrepRequestSchema = createMediaPrepRequestSchema({
  allowedMimeTypes: [...DROP_MEDIA_ALLOWED_MIME_TYPES],
  allowedExtensionsByMimeType: DROP_MEDIA_ALLOWED_EXTENSIONS_BY_MIME_TYPE
});

function mapDropMediaStatus(status: string): ApiDropMediaStatus {
  switch (status) {
    case ApiDropMediaStatus.Uploading:
      return ApiDropMediaStatus.Uploading;
    case ApiDropMediaStatus.Processing:
      return ApiDropMediaStatus.Processing;
    case ApiDropMediaStatus.Failed:
      return ApiDropMediaStatus.Failed;
    case ApiDropMediaStatus.Ready:
    default:
      return ApiDropMediaStatus.Ready;
  }
}

export default router;
