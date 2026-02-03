import { Request, Response } from 'express';
import * as Joi from 'joi';
import { invalidateCloudFront } from '../../../cloudfront';
import { CLOUDFRONT_DISTRIBUTION } from '@/constants';
import { BadRequestException, ForbiddenException } from '../../../exceptions';
import { numbers } from '../../../numbers';
import { evictKeyFromRedisCache } from '../../../redis';
import {
  getCacheKeyPatternForPath,
  getPage,
  getPageSize,
  returnPaginatedResult
} from '../api-helpers';
import { ApiResponse } from '../api-response';
import { asyncRouter } from '../async.router';
import { needsAuthenticatedUser } from '../auth/auth';
import { ApiCompleteMultipartUploadRequest } from '../generated/models/ApiCompleteMultipartUploadRequest';
import { ApiCompleteMultipartUploadResponse } from '../generated/models/ApiCompleteMultipartUploadResponse';
import { ApiCreateMediaUploadUrlRequest } from '../generated/models/ApiCreateMediaUploadUrlRequest';
import { ApiCreateMediaUrlResponse } from '../generated/models/ApiCreateMediaUrlResponse';
import { ApiStartMultipartMediaUploadResponse } from '../generated/models/ApiStartMultipartMediaUploadResponse';
import { ApiUploadPartOfMultipartUploadRequest } from '../generated/models/ApiUploadPartOfMultipartUploadRequest';
import { ApiUploadPartOfMultipartUploadResponse } from '../generated/models/ApiUploadPartOfMultipartUploadResponse';
import { DistributionPhotoCompleteRequest } from '../generated/models/DistributionPhotoCompleteRequest';
import {
  ApiCompleteMultipartUploadRequestSchema,
  ApiUploadPartOfMultipartUploadRequestSchema,
  createDistributionPhotoMediaPrepRequestSchema
} from '../media/media-uplodad.validators';
import { uploadMediaService } from '../media/upload-media.service';
import { cacheRequest } from '../request-cache';
import { authenticateSubscriptionsAdmin } from '../subscriptions/api.subscriptions.allowlist';
import { getValidatedByJoiOrThrow } from '../validation';
import {
  fetchDistributionPhotos,
  saveDistributionPhotos
} from './api.distribution_photos.db';

const router = asyncRouter();

router.get(
  `/:contract/:nft_id`,
  cacheRequest(),
  async function (req: any, res: any) {
    const contract = req.params.contract;
    const nftId = req.params.nft_id;

    const pageSize = getPageSize(req);
    const page = getPage(req);

    await fetchDistributionPhotos(contract, nftId, pageSize, page).then(
      (result) => {
        return returnPaginatedResult(result, req, res);
      }
    );
  }
);

router.post(
  `/:contract/:nft_id/prep`,
  needsAuthenticatedUser(),
  async (
    req: Request<
      { contract: string; nft_id: string },
      any,
      ApiCreateMediaUploadUrlRequest,
      any,
      any
    >,
    res: Response<ApiResponse<ApiCreateMediaUrlResponse>>
  ) => {
    const authenticated = authenticateSubscriptionsAdmin(req);
    if (!authenticated) {
      throw new ForbiddenException(
        'Only Subscription Admins can upload photos'
      );
    }

    const contract = req.params.contract;
    const nftId = numbers.parseIntOrNull(req.params.nft_id);

    if (nftId === null) {
      throw new BadRequestException('Invalid nft_id parameter');
    }

    const validatedRequest = getValidatedByJoiOrThrow(
      req.body,
      DistributionPhotoPrepRequestSchema
    );

    const response =
      await uploadMediaService.createSignedDistributionPhotoUploadUrl({
        content_type: validatedRequest.content_type,
        file_name: validatedRequest.file_name,
        contract,
        card_id: nftId
      });
    res.send(response);
  }
);

router.post(
  `/:contract/:nft_id/multipart-upload`,
  needsAuthenticatedUser(),
  async (
    req: Request<
      { contract: string; nft_id: string },
      any,
      ApiCreateMediaUploadUrlRequest,
      any,
      any
    >,
    res: Response<ApiResponse<ApiStartMultipartMediaUploadResponse>>
  ) => {
    const authenticated = authenticateSubscriptionsAdmin(req);
    if (!authenticated) {
      throw new ForbiddenException(
        'Only Subscription Admins can upload photos'
      );
    }

    const contract = req.params.contract;
    const nftId = numbers.parseIntOrNull(req.params.nft_id);

    if (nftId === null) {
      throw new BadRequestException('Invalid nft_id parameter');
    }

    const validatedRequest = getValidatedByJoiOrThrow(
      req.body,
      DistributionPhotoPrepRequestSchema
    );

    const { key, upload_id } =
      await uploadMediaService.getDistributionPhotoMultipartUploadKeyAndUploadId(
        {
          content_type: validatedRequest.content_type,
          file_name: validatedRequest.file_name,
          contract,
          card_id: nftId
        }
      );

    res.send({
      upload_id,
      key
    });
  }
);

router.post(
  `/:contract/:nft_id/multipart-upload/part`,
  needsAuthenticatedUser(),
  async (
    req: Request<
      { contract: string; nft_id: string },
      any,
      ApiUploadPartOfMultipartUploadRequest,
      any,
      any
    >,
    res: Response<ApiResponse<ApiUploadPartOfMultipartUploadResponse>>
  ) => {
    const authenticated = authenticateSubscriptionsAdmin(req);
    if (!authenticated) {
      throw new ForbiddenException(
        'Only Subscription Admins can upload photos'
      );
    }

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

const DistributionPhotoCompleteRequestSchema: Joi.ObjectSchema<DistributionPhotoCompleteRequest> =
  Joi.object({
    photos: Joi.array()
      .required()
      .min(1)
      .items(
        Joi.object({
          media_url: Joi.string().required()
        })
      )
  });

router.post(
  `/:contract/:nft_id/complete`,
  needsAuthenticatedUser(),
  async function (
    req: Request<
      { contract: string; nft_id: string },
      any,
      DistributionPhotoCompleteRequest,
      any
    >,
    res: Response
  ) {
    const authenticated = authenticateSubscriptionsAdmin(req);
    if (!authenticated) {
      throw new ForbiddenException(
        'Only Subscription Admins can upload photos'
      );
    }

    const contract = req.params.contract;
    const nftId = numbers.parseIntOrNull(req.params.nft_id);

    if (nftId === null) {
      throw new BadRequestException('Invalid nft_id parameter');
    }

    const validatedRequest = getValidatedByJoiOrThrow(
      req.body,
      DistributionPhotoCompleteRequestSchema
    );

    const photoUrls = validatedRequest.photos.map((p) => p.media_url);

    await saveDistributionPhotos(contract, nftId, photoUrls);

    const invalidationPath = `/distribution/${process.env.NODE_ENV}/${contract}/${nftId}/*`;
    await invalidateCloudFront(CLOUDFRONT_DISTRIBUTION, [invalidationPath]);

    const overviewCacheKey = getCacheKeyPatternForPath(
      `/api/distributions/${contract}/${nftId}/overview`
    );
    await evictKeyFromRedisCache(overviewCacheKey);

    return res.json({
      success: true,
      photos: photoUrls
    });
  }
);

router.post(
  `/:contract/:nft_id/multipart-upload/completion`,
  needsAuthenticatedUser(),
  async (
    req: Request<
      { contract: string; nft_id: string },
      any,
      ApiCompleteMultipartUploadRequest,
      any,
      any
    >,
    res: Response<ApiResponse<ApiCompleteMultipartUploadResponse>>
  ) => {
    const authenticated = authenticateSubscriptionsAdmin(req);
    if (!authenticated) {
      throw new ForbiddenException(
        'Only Subscription Admins can upload photos'
      );
    }

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

const DistributionPhotoPrepRequestSchema: Joi.ObjectSchema<ApiCreateMediaUploadUrlRequest> =
  createDistributionPhotoMediaPrepRequestSchema({
    allowedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  });

export default router;
