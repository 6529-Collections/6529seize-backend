import {
  AttachmentEntity,
  AttachmentKind,
  AttachmentStatus
} from '@/entities/IAttachment';
import { mapAttachmentSafetyToApi } from './attachments.mappers';
import { ApiAttachmentSafetyScanner } from '@/api/generated/models/ApiAttachmentSafetyScanner';
import { ApiAttachmentSafetyStatus } from '@/api/generated/models/ApiAttachmentSafetyStatus';
import { ApiAttachmentSafetyValidation } from '@/api/generated/models/ApiAttachmentSafetyValidation';

describe('attachments mappers', () => {
  const baseAttachment: AttachmentEntity = {
    id: 'attachment-1',
    owner_profile_id: 'profile-1',
    original_file_name: 'report.pdf',
    kind: AttachmentKind.PDF,
    declared_mime: 'application/pdf',
    detected_mime: null,
    status: AttachmentStatus.UPLOADING,
    original_bucket: 'private-bucket',
    original_key: 'attachments/report.pdf',
    size_bytes: null,
    sha256: null,
    guardduty_status: null,
    verdict: null,
    ipfs_cid: null,
    ipfs_url: null,
    error_reason: null,
    created_at: 1,
    updated_at: 1
  };

  it('maps in-progress statuses to pending safety', () => {
    for (const status of [
      AttachmentStatus.UPLOADING,
      AttachmentStatus.VERIFYING,
      AttachmentStatus.PROCESSING
    ]) {
      expect(
        mapAttachmentSafetyToApi({
          ...baseAttachment,
          status
        })
      ).toEqual({
        status: ApiAttachmentSafetyStatus.Pending,
        scanner:
          status === AttachmentStatus.UPLOADING
            ? null
            : ApiAttachmentSafetyScanner.Guardduty,
        validation: null,
        size_bytes: null,
        sha256: null
      });
    }
  });

  it('maps validated ready attachments to scanned and validated safety', () => {
    expect(
      mapAttachmentSafetyToApi({
        ...baseAttachment,
        status: AttachmentStatus.READY,
        verdict: 'VALIDATED_FOR_PUBLIC_IPFS',
        size_bytes: 1234,
        sha256: 'a'.repeat(64)
      })
    ).toEqual({
      status: ApiAttachmentSafetyStatus.ScannedValidated,
      scanner: ApiAttachmentSafetyScanner.Guardduty,
      validation: ApiAttachmentSafetyValidation.PublicIpfsValidated,
      size_bytes: 1234,
      sha256: 'a'.repeat(64)
    });
  });

  it('does not mark ready attachments validated without the validation verdict', () => {
    expect(
      mapAttachmentSafetyToApi({
        ...baseAttachment,
        status: AttachmentStatus.READY,
        verdict: null
      })
    ).toBeUndefined();
  });

  it('maps blocked and failed attachments to terminal safety states', () => {
    expect(
      mapAttachmentSafetyToApi({
        ...baseAttachment,
        status: AttachmentStatus.BLOCKED
      })
    ).toEqual(
      expect.objectContaining({
        status: ApiAttachmentSafetyStatus.Blocked
      })
    );
    expect(
      mapAttachmentSafetyToApi({
        ...baseAttachment,
        status: AttachmentStatus.FAILED
      })
    ).toEqual(
      expect.objectContaining({
        status: ApiAttachmentSafetyStatus.Failed
      })
    );
  });
});
