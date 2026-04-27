import {
  AttachmentEntity,
  AttachmentKind,
  AttachmentStatus
} from '@/entities/IAttachment';
import { ApiAttachment } from '@/api/generated/models/ApiAttachment';
import { ApiAttachmentKind } from '@/api/generated/models/ApiAttachmentKind';
import { ApiAttachmentStatus } from '@/api/generated/models/ApiAttachmentStatus';

export function mapAttachmentToApiAttachment(
  attachment: AttachmentEntity
): ApiAttachment {
  return {
    id: attachment.id,
    file_name: attachment.original_file_name,
    mime_type: attachment.declared_mime,
    kind:
      attachment.kind === AttachmentKind.PDF
        ? ApiAttachmentKind.Pdf
        : ApiAttachmentKind.Csv,
    status: mapAttachmentStatusToApi(attachment.status),
    url: attachment.ipfs_url,
    error_reason: attachment.error_reason
  };
}

export function mapAttachmentStatusToApi(
  status: AttachmentStatus
): ApiAttachmentStatus {
  switch (status) {
    case AttachmentStatus.UPLOADING:
      return ApiAttachmentStatus.Uploading;
    case AttachmentStatus.VERIFYING:
      return ApiAttachmentStatus.Verifying;
    case AttachmentStatus.PROCESSING:
      return ApiAttachmentStatus.Processing;
    case AttachmentStatus.READY:
      return ApiAttachmentStatus.Ready;
    case AttachmentStatus.BLOCKED:
    case AttachmentStatus.FAILED:
      return ApiAttachmentStatus.Bad;
  }
}
