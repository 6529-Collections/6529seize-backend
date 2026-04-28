import { asyncRouter } from '@/api/async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '@/api/api-response';
import {
  getAuthenticatedProfileIdOrNull,
  needsAuthenticatedUser
} from '@/api/auth/auth';
import {
  ApiCompliantException,
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import {
  ApiCompleteMultipartUploadRequestPartSchema,
  ApiUploadPartOfMultipartUploadRequestSchema,
  createMediaPrepRequestSchema
} from '@/api/media/media-uplodad.validators';
import {
  ATTACHMENT_ALLOWED_EXTENSIONS_BY_MIME_TYPE,
  ATTACHMENT_ALLOWED_MIME_TYPES
} from '@/api/media/media-mime-types';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { attachmentsDb } from '@/attachments/attachments.db';
import {
  AttachmentEntity,
  AttachmentKind,
  AttachmentStatus
} from '@/entities/IAttachment';
import { uploadAttachmentsService } from '@/api/attachments/upload-attachments.service';
import { ApiUploadPartOfMultipartUploadRequest } from '@/api/generated/models/ApiUploadPartOfMultipartUploadRequest';
import { ApiUploadPartOfMultipartUploadResponse } from '@/api/generated/models/ApiUploadPartOfMultipartUploadResponse';
import { ApiAttachment } from '@/api/generated/models/ApiAttachment';
import { ApiCreateAttachmentMultipartUploadRequest } from '@/api/generated/models/ApiCreateAttachmentMultipartUploadRequest';
import { ApiCreateAttachmentMultipartUploadResponse } from '@/api/generated/models/ApiCreateAttachmentMultipartUploadResponse';
import { ApiCompleteAttachmentMultipartUploadRequest } from '@/api/generated/models/ApiCompleteAttachmentMultipartUploadRequest';
import { ApiAttachmentStatus } from '@/api/generated/models/ApiAttachmentStatus';
import * as Joi from 'joi';
import { mapAttachmentToApiAttachment } from '@/api/attachments/attachments.mappers';
import { attachmentsStatusNotifier } from '@/attachments/attachments-status-notifier';
import { randomUUID } from 'node:crypto';
import { Time, Timer } from '@/time';

const router = asyncRouter();

const AttachmentMultipartUploadRequestSchema = createMediaPrepRequestSchema({
  allowedMimeTypes: [...ATTACHMENT_ALLOWED_MIME_TYPES],
  allowedExtensionsByMimeType: ATTACHMENT_ALLOWED_EXTENSIONS_BY_MIME_TYPE
});

const AttachmentMultipartCompletionRequestSchema: Joi.ObjectSchema<ApiCompleteAttachmentMultipartUploadRequest> =
  Joi.object({
    attachment_id: Joi.string().required(),
    upload_id: Joi.string().required(),
    key: Joi.string().required(),
    parts: Joi.array()
      .required()
      .min(1)
      .items(ApiCompleteMultipartUploadRequestPartSchema)
  });

const AttachmentParamsSchema: Joi.ObjectSchema<{ attachment_id: string }> =
  Joi.object({
    attachment_id: Joi.string().required()
  });

const ATTACHMENT_KIND_BY_MIME_TYPE: Record<string, AttachmentKind> = {
  'application/pdf': AttachmentKind.PDF,
  'text/csv': AttachmentKind.CSV
};

function getAttachmentKind(contentType: string): AttachmentKind {
  const kind = ATTACHMENT_KIND_BY_MIME_TYPE[contentType];
  if (!kind) {
    throw new BadRequestException(
      `Unsupported attachment content type ${contentType}`
    );
  }
  return kind;
}

function mapMultipartCompletionError(error: unknown): ApiCompliantException {
  if (error instanceof ApiCompliantException) {
    return error;
  }
  const errorName =
    typeof (error as { name?: unknown }).name === 'string'
      ? (error as { name: string }).name
      : '';
  const errorCode =
    typeof (error as { Code?: unknown }).Code === 'string'
      ? (error as { Code: string }).Code
      : '';
  const code = errorName || errorCode;
  if (
    [
      'NoSuchUpload',
      'InvalidPart',
      'InvalidPartOrder',
      'EntityTooSmall'
    ].includes(code)
  ) {
    return new BadRequestException(
      error instanceof Error ? error.message : 'Invalid multipart upload'
    );
  }
  return new CustomApiCompliantException(
    500,
    'Attachment multipart upload completion failed'
  );
}

router.post(
  '/multipart-upload',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiCreateAttachmentMultipartUploadRequest, any, any>,
    res: Response<ApiResponse<ApiCreateAttachmentMultipartUploadResponse>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticatedProfileId = await getAuthenticatedProfileIdOrNull(req);
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }

    const validated = getValidatedByJoiOrThrow(
      {
        ...req.body,
        author: authenticatedProfileId
      },
      AttachmentMultipartUploadRequestSchema
    );

    const attachmentId = randomUUID();
    const now = Time.currentMillis();
    const { key, upload_id } =
      await uploadAttachmentsService.createMultipartUpload({
        attachmentId,
        authorId: authenticatedProfileId,
        contentType: validated.content_type,
        fileName: validated.file_name
      });
    const attachment: AttachmentEntity = {
      id: attachmentId,
      owner_profile_id: authenticatedProfileId,
      original_file_name: validated.file_name,
      kind: getAttachmentKind(validated.content_type),
      declared_mime: validated.content_type,
      detected_mime: null,
      status: AttachmentStatus.UPLOADING,
      original_bucket: process.env.ATTACHMENTS_INGEST_S3_BUCKET ?? null,
      original_key: key,
      size_bytes: null,
      sha256: null,
      guardduty_status: null,
      verdict: null,
      ipfs_cid: null,
      ipfs_url: null,
      error_reason: null,
      created_at: now,
      updated_at: now
    };
    await attachmentsDb.createAttachment(attachment, { timer });
    res.send({
      attachment_id: attachmentId,
      upload_id,
      key,
      status: ApiAttachmentStatus.Uploading
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
    const authenticatedProfileId = await getAuthenticatedProfileIdOrNull(req);
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const validatedRequest = getValidatedByJoiOrThrow(
      req.body,
      ApiUploadPartOfMultipartUploadRequestSchema
    );
    const attachment = await attachmentsDb.findAttachmentByOriginalLocation({
      originalBucket: process.env.ATTACHMENTS_INGEST_S3_BUCKET ?? '',
      originalKey: validatedRequest.key
    });
    if (attachment?.owner_profile_id !== authenticatedProfileId) {
      throw new NotFoundException(`Attachment upload not found`);
    }
    const upload_url =
      await uploadAttachmentsService.getSignedUrlForPartOfMultipartUpload(
        validatedRequest
      );
    res.send({ upload_url });
  }
);

router.post(
  '/multipart-upload/completion',
  needsAuthenticatedUser(),
  async (
    req: Request<
      any,
      any,
      ApiCompleteAttachmentMultipartUploadRequest,
      any,
      any
    >,
    res: Response<ApiResponse<ApiAttachment>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticatedProfileId = await getAuthenticatedProfileIdOrNull(req);
    if (!authenticatedProfileId) {
      throw new ForbiddenException(`Please create a profile first`);
    }
    const validatedRequest = getValidatedByJoiOrThrow(
      req.body,
      AttachmentMultipartCompletionRequestSchema
    );
    const attachment = await attachmentsDb.findAttachmentById(
      validatedRequest.attachment_id
    );
    if (attachment?.owner_profile_id !== authenticatedProfileId) {
      throw new NotFoundException(
        `Attachment ${validatedRequest.attachment_id} not found`
      );
    }
    if (validatedRequest.key !== attachment.original_key) {
      throw new BadRequestException(
        `Attachment ${validatedRequest.attachment_id} key does not match`
      );
    }
    try {
      await uploadAttachmentsService.completeMultipartUpload(validatedRequest);
    } catch (error) {
      throw mapMultipartCompletionError(error);
    }
    const completedAt = Time.currentMillis();
    await attachmentsDb.updateAttachment(
      {
        id: attachment.id,
        patch: {
          status: AttachmentStatus.VERIFYING,
          updated_at: completedAt
        }
      },
      { timer }
    );
    const refreshedAttachment = await attachmentsDb.findAttachmentById(
      attachment.id
    );
    const finalAttachment = refreshedAttachment ?? {
      ...attachment,
      status: AttachmentStatus.VERIFYING,
      updated_at: completedAt
    };
    await attachmentsStatusNotifier.notifyStatusTransition(finalAttachment, {
      timer
    });
    res.send(mapAttachmentToApiAttachment(finalAttachment));
  }
);

router.get(
  '/:attachment_id',
  needsAuthenticatedUser(),
  async (
    req: Request<{ attachment_id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiAttachment>>
  ) => {
    const params = getValidatedByJoiOrThrow(req.params, AttachmentParamsSchema);
    const attachment = await attachmentsDb.findAttachmentById(
      params.attachment_id
    );
    const authenticatedProfileId = await getAuthenticatedProfileIdOrNull(req);
    if (attachment?.owner_profile_id !== authenticatedProfileId) {
      throw new NotFoundException(
        `Attachment ${params.attachment_id} not found`
      );
    }
    res.send(mapAttachmentToApiAttachment(attachment));
  }
);

export default router;
