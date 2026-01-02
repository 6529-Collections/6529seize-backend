import * as Joi from 'joi';
import { ApiUploadPartOfMultipartUploadRequest } from '../generated/models/ApiUploadPartOfMultipartUploadRequest';
import { ApiCompleteMultipartUploadRequestPart } from '../generated/models/ApiCompleteMultipartUploadRequestPart';
import { ApiCompleteMultipartUploadRequest } from '../generated/models/ApiCompleteMultipartUploadRequest';
import { ApiCreateMediaUploadUrlRequest } from '../generated/models/ApiCreateMediaUploadUrlRequest';

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
  allowedMimeTypes
}: {
  allowedMimeTypes: string[];
}): Joi.ObjectSchema<ApiCreateMediaUploadUrlRequest & { author: string }> {
  return Joi.object({
    author: Joi.string().required(),
    content_type: Joi.string()
      .required()
      .valid(...allowedMimeTypes),
    file_name: Joi.string().required()
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
