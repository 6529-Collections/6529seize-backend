import {
  AttachmentEntity,
  AttachmentKind,
  AttachmentStatus
} from '@/entities/IAttachment';
import { ApiAttachment } from '@/api/generated/models/ApiAttachment';
import { ApiAttachmentKind } from '@/api/generated/models/ApiAttachmentKind';
import { ApiAttachmentSafety } from '@/api/generated/models/ApiAttachmentSafety';
import { ApiAttachmentSafetyScanner } from '@/api/generated/models/ApiAttachmentSafetyScanner';
import { ApiAttachmentSafetyStatus } from '@/api/generated/models/ApiAttachmentSafetyStatus';
import { ApiAttachmentSafetyValidation } from '@/api/generated/models/ApiAttachmentSafetyValidation';
import { ApiAttachmentStatus } from '@/api/generated/models/ApiAttachmentStatus';
import { ApiAttachmentUploadMimeType } from '@/api/generated/models/ApiAttachmentUploadMimeType';

const PUBLIC_IPFS_VALIDATED_VERDICT = 'VALIDATED_FOR_PUBLIC_IPFS';

export function mapAttachmentToApiAttachment(
  attachment: AttachmentEntity
): ApiAttachment {
  const safety = mapAttachmentSafetyToApi(attachment);

  return {
    attachment_id: attachment.id,
    file_name: attachment.original_file_name,
    mime_type: mapAttachmentMimeTypeToApi(attachment.declared_mime),
    kind:
      attachment.kind === AttachmentKind.PDF
        ? ApiAttachmentKind.Pdf
        : ApiAttachmentKind.Csv,
    status: mapAttachmentStatusToApi(attachment.status),
    url: attachment.ipfs_url,
    error_reason: attachment.error_reason,
    ...(safety ? { safety } : {})
  };
}

function mapAttachmentMimeTypeToApi(
  mimeType: string
): ApiAttachmentUploadMimeType {
  switch (mimeType) {
    case ApiAttachmentUploadMimeType.ApplicationPdf:
      return ApiAttachmentUploadMimeType.ApplicationPdf;
    case ApiAttachmentUploadMimeType.TextCsv:
      return ApiAttachmentUploadMimeType.TextCsv;
    default:
      throw new Error(`Unsupported attachment MIME type ${mimeType}`);
  }
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

export function mapAttachmentSafetyToApi(
  attachment: AttachmentEntity
): ApiAttachmentSafety | undefined {
  const scannedAndValidated =
    attachment.status === AttachmentStatus.READY &&
    attachment.verdict === PUBLIC_IPFS_VALIDATED_VERDICT;

  if (attachment.status === AttachmentStatus.READY && !scannedAndValidated) {
    return undefined;
  }

  return {
    status: mapAttachmentSafetyStatusToApi(attachment),
    scanner: shouldShowGuardDutyScanner(attachment.status)
      ? ApiAttachmentSafetyScanner.Guardduty
      : null,
    validation: scannedAndValidated
      ? ApiAttachmentSafetyValidation.PublicIpfsValidated
      : null,
    size_bytes: attachment.size_bytes,
    sha256: attachment.sha256
  };
}

function mapAttachmentSafetyStatusToApi(
  attachment: AttachmentEntity
): ApiAttachmentSafetyStatus {
  switch (attachment.status) {
    case AttachmentStatus.UPLOADING:
    case AttachmentStatus.VERIFYING:
    case AttachmentStatus.PROCESSING:
      return ApiAttachmentSafetyStatus.Pending;
    case AttachmentStatus.READY:
      return ApiAttachmentSafetyStatus.ScannedValidated;
    case AttachmentStatus.BLOCKED:
      return ApiAttachmentSafetyStatus.Blocked;
    case AttachmentStatus.FAILED:
      return ApiAttachmentSafetyStatus.Failed;
  }
}

function shouldShowGuardDutyScanner(status: AttachmentStatus): boolean {
  return status !== AttachmentStatus.UPLOADING;
}
