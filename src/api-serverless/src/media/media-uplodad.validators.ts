import * as Joi from 'joi';
import { ApiUploadPartOfMultipartUploadRequest } from '../generated/models/ApiUploadPartOfMultipartUploadRequest';
import { ApiCompleteMultipartUploadRequestPart } from '../generated/models/ApiCompleteMultipartUploadRequestPart';
import { ApiCompleteMultipartUploadRequest } from '../generated/models/ApiCompleteMultipartUploadRequest';
import { ApiCreateMediaUploadUrlRequest } from '../generated/models/ApiCreateMediaUploadUrlRequest';
import { DANGEROUS_MEDIA_FILE_EXTENSIONS } from '@/api/media/media-mime-types';

export const ApiUploadPartOfMultipartUploadRequestSchema: Joi.ObjectSchema<ApiUploadPartOfMultipartUploadRequest> =
  Joi.object({
    upload_id: Joi.string().required(),
    key: Joi.string().required(),
    part_no: Joi.number().integer().min(1).required()
  });

export const ApiCompleteMultipartUploadRequestPartSchema: Joi.ObjectSchema<ApiCompleteMultipartUploadRequestPart> =
  Joi.object({
    etag: Joi.string().required(),
    part_no: Joi.number().integer().min(1).required()
  });

export const ApiCompleteMultipartUploadRequestSchema: Joi.ObjectSchema<ApiCompleteMultipartUploadRequest> =
  Joi.object({
    upload_id: Joi.string().required(),
    key: Joi.string().required(),
    parts: Joi.array()
      .required()
      .min(1)
      .items(ApiCompleteMultipartUploadRequestPartSchema)
  });

export function createMediaPrepRequestSchema({
  allowedMimeTypes,
  allowedExtensionsByMimeType
}: {
  allowedMimeTypes: string[];
  allowedExtensionsByMimeType?: Record<string, readonly string[]>;
}): Joi.ObjectSchema<{
  author: string;
  content_type: string;
  file_name: string;
}> {
  return Joi.object({
    author: Joi.string().required(),
    content_type: Joi.string()
      .required()
      .valid(...allowedMimeTypes),
    file_name: Joi.string()
      .required()
      .custom((fileName, helpers) => {
        const contentType = helpers.state.ancestors[0]?.content_type;
        if (
          allowedExtensionsByMimeType &&
          !isAllowedMediaFileName(
            fileName,
            contentType,
            allowedExtensionsByMimeType
          )
        ) {
          return helpers.error('any.invalid');
        }
        return fileName;
      })
  });
}

export function createDistributionPhotoMediaPrepRequestSchema({
  allowedMimeTypes
}: {
  allowedMimeTypes: string[];
}): Joi.ObjectSchema<ApiCreateMediaUploadUrlRequest> {
  return Joi.object({
    content_type: Joi.string()
      .required()
      .valid(...allowedMimeTypes),
    file_name: Joi.string().required()
  });
}

function isAllowedMediaFileName(
  fileName: string,
  contentType: unknown,
  allowedExtensionsByMimeType: Record<string, readonly string[]>
): boolean {
  if (
    typeof contentType !== 'string' ||
    !(contentType in allowedExtensionsByMimeType) ||
    fileName !== fileName.trim() ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0')
  ) {
    return false;
  }

  const lowerFileName = fileName.toLowerCase();
  const fileExtensions = lowerFileName.match(/\.[^.]+/g) ?? [];
  if (
    fileExtensions.some((extension) =>
      (DANGEROUS_MEDIA_FILE_EXTENSIONS as readonly string[]).includes(extension)
    )
  ) {
    return false;
  }

  const allowedExtensions = allowedExtensionsByMimeType[contentType];
  return allowedExtensions.some((extension) =>
    lowerFileName.endsWith(extension)
  );
}
