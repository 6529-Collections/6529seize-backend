import { GetObjectTaggingCommand } from '@aws-sdk/client-s3';
import { attachmentsDb, AttachmentsDb } from '@/attachments/attachments.db';
import { enqueueAttachmentOrchestrationRetry } from '@/attachments/attachments-orchestration-publisher';
import { enqueueAttachmentProcessing } from '@/attachments/attachments-processing-publisher';
import {
  attachmentsStatusNotifier,
  AttachmentsStatusNotifier
} from '@/attachments/attachments-status-notifier';
import { AttachmentStatus } from '@/entities/IAttachment';
import { Logger } from '@/logging';
import { getS3 } from '@/s3.client';
import { Time } from '@/time';

const GUARDDUTY_STATUS_TAG = 'GuardDutyMalwareScanStatus';
const MAX_GUARDDUTY_POLL_ATTEMPTS = 20;

type FinalGuardDutyStatus =
  | 'NO_THREATS_FOUND'
  | 'THREATS_FOUND'
  | 'UNSUPPORTED'
  | 'ACCESS_DENIED'
  | 'FAILED';

export class AttachmentsOrchestratorService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly attachmentsDb: AttachmentsDb,
    private readonly statusNotifier: AttachmentsStatusNotifier
  ) {}

  public async handleObjectCreated({
    originalBucket,
    originalKey
  }: {
    originalBucket: string;
    originalKey: string;
  }): Promise<void> {
    await this.orchestrate({
      originalBucket,
      originalKey,
      uploadAttempt: 0,
      scanAttempt: 0
    });
  }

  public async handleRetryMessage({
    attachmentId,
    originalBucket,
    originalKey,
    uploadAttempt,
    scanAttempt
  }: {
    attachmentId: string;
    originalBucket: string;
    originalKey: string;
    uploadAttempt: number;
    scanAttempt: number;
  }): Promise<void> {
    await this.orchestrate({
      attachmentId,
      originalBucket,
      originalKey,
      uploadAttempt,
      scanAttempt
    });
  }

  private async orchestrate({
    attachmentId,
    originalBucket,
    originalKey,
    uploadAttempt,
    scanAttempt
  }: {
    attachmentId?: string;
    originalBucket: string;
    originalKey: string;
    uploadAttempt: number;
    scanAttempt: number;
  }): Promise<void> {
    const attachment = attachmentId
      ? await this.attachmentsDb.findAttachmentById(attachmentId)
      : await this.attachmentsDb.findAttachmentByOriginalLocation({
          originalBucket,
          originalKey
        });

    if (!attachment) {
      if (uploadAttempt >= MAX_GUARDDUTY_POLL_ATTEMPTS) {
        throw new Error(
          `Attachment row not found for ${originalBucket}/${originalKey} after ${uploadAttempt} attempts`
        );
      }
      await enqueueAttachmentOrchestrationRetry({
        attachmentId: attachmentId ?? '',
        originalBucket,
        originalKey,
        uploadAttempt: uploadAttempt + 1,
        scanAttempt,
        delaySeconds: this.getRetryDelaySeconds(uploadAttempt)
      });
      return;
    }

    if (
      [
        AttachmentStatus.READY,
        AttachmentStatus.BLOCKED,
        AttachmentStatus.FAILED,
        AttachmentStatus.PROCESSING
      ].includes(attachment.status)
    ) {
      return;
    }

    if (attachment.status === AttachmentStatus.UPLOADING) {
      if (uploadAttempt >= MAX_GUARDDUTY_POLL_ATTEMPTS) {
        const updatedAt = Time.currentMillis();
        const failedPatch = {
          verdict: 'UPLOAD_COMPLETION_TIMEOUT',
          error_reason: 'Attachment completion did not finalize in time'
        };
        const transitioned =
          await this.attachmentsDb.transitionAttachmentStatus({
            id: attachment.id,
            fromStatus: AttachmentStatus.UPLOADING,
            toStatus: AttachmentStatus.FAILED,
            updatedAt,
            patch: failedPatch
          });
        if (transitioned) {
          await this.statusNotifier.notifyStatusTransition({
            ...attachment,
            ...failedPatch,
            status: AttachmentStatus.FAILED,
            updated_at: updatedAt
          });
        }
        return;
      }
      await enqueueAttachmentOrchestrationRetry({
        attachmentId: attachment.id,
        originalBucket,
        originalKey,
        uploadAttempt: uploadAttempt + 1,
        scanAttempt,
        delaySeconds: this.getRetryDelaySeconds(uploadAttempt)
      });
      return;
    }

    const guardDutyStatus = await this.getGuardDutyStatus({
      originalBucket,
      originalKey
    });

    if (!guardDutyStatus) {
      if (scanAttempt >= MAX_GUARDDUTY_POLL_ATTEMPTS) {
        const updatedAt = Time.currentMillis();
        const failedPatch = {
          verdict: 'MALWARE_SCAN_TIMEOUT',
          error_reason: 'GuardDuty scan result was not available in time'
        };
        const transitioned =
          await this.attachmentsDb.transitionAttachmentStatus({
            id: attachment.id,
            fromStatus: AttachmentStatus.VERIFYING,
            toStatus: AttachmentStatus.FAILED,
            updatedAt,
            patch: failedPatch
          });
        if (transitioned) {
          await this.statusNotifier.notifyStatusTransition({
            ...attachment,
            ...failedPatch,
            status: AttachmentStatus.FAILED,
            updated_at: updatedAt
          });
        }
        return;
      }
      await enqueueAttachmentOrchestrationRetry({
        attachmentId: attachment.id,
        originalBucket,
        originalKey,
        uploadAttempt,
        scanAttempt: scanAttempt + 1,
        delaySeconds: this.getRetryDelaySeconds(scanAttempt)
      });
      return;
    }

    if (guardDutyStatus === 'NO_THREATS_FOUND') {
      const updatedAt = Time.currentMillis();
      const transitioned = await this.attachmentsDb.transitionAttachmentStatus({
        id: attachment.id,
        fromStatus: AttachmentStatus.VERIFYING,
        toStatus: AttachmentStatus.VERIFYING,
        updatedAt,
        patch: {
          guardduty_status: guardDutyStatus,
          error_reason: null
        }
      });
      if (transitioned) {
        await enqueueAttachmentProcessing(attachment.id);
      }
      return;
    }

    if (
      guardDutyStatus === 'THREATS_FOUND' ||
      guardDutyStatus === 'UNSUPPORTED'
    ) {
      const updatedAt = Time.currentMillis();
      const blockedPatch = {
        guardduty_status: guardDutyStatus,
        verdict: `MALWARE_SCAN_${guardDutyStatus}`,
        error_reason: `GuardDuty blocked attachment (${guardDutyStatus})`
      };
      const transitioned = await this.attachmentsDb.transitionAttachmentStatus({
        id: attachment.id,
        fromStatus: AttachmentStatus.VERIFYING,
        toStatus: AttachmentStatus.BLOCKED,
        updatedAt,
        patch: blockedPatch
      });
      if (transitioned) {
        await this.statusNotifier.notifyStatusTransition({
          ...attachment,
          ...blockedPatch,
          status: AttachmentStatus.BLOCKED,
          updated_at: updatedAt
        });
      }
      return;
    }

    const updatedAt = Time.currentMillis();
    const failedPatch = {
      guardduty_status: guardDutyStatus,
      verdict: `MALWARE_SCAN_${guardDutyStatus}`,
      error_reason: `GuardDuty scan failed (${guardDutyStatus})`
    };
    const transitioned = await this.attachmentsDb.transitionAttachmentStatus({
      id: attachment.id,
      fromStatus: AttachmentStatus.VERIFYING,
      toStatus: AttachmentStatus.FAILED,
      updatedAt,
      patch: failedPatch
    });
    if (transitioned) {
      await this.statusNotifier.notifyStatusTransition({
        ...attachment,
        ...failedPatch,
        status: AttachmentStatus.FAILED,
        updated_at: updatedAt
      });
    }
  }

  private async getGuardDutyStatus({
    originalBucket,
    originalKey
  }: {
    originalBucket: string;
    originalKey: string;
  }): Promise<FinalGuardDutyStatus | null> {
    const response = await getS3().send(
      new GetObjectTaggingCommand({
        Bucket: originalBucket,
        Key: originalKey
      })
    );
    const tag = response.TagSet?.find((it) => it.Key === GUARDDUTY_STATUS_TAG);
    const value =
      typeof tag?.Value === 'string' && tag.Value.trim()
        ? tag.Value.trim()
        : '';
    if (!value) {
      return null;
    }
    if (
      value === 'NO_THREATS_FOUND' ||
      value === 'THREATS_FOUND' ||
      value === 'UNSUPPORTED' ||
      value === 'ACCESS_DENIED' ||
      value === 'FAILED'
    ) {
      return value;
    }
    this.logger.info(`Ignoring non-final GuardDuty status ${value}`);
    return null;
  }

  private getRetryDelaySeconds(attempt: number): number {
    return Math.min(30 * Math.max(1, attempt + 1), 300);
  }
}

export const attachmentsOrchestratorService =
  new AttachmentsOrchestratorService(attachmentsDb, attachmentsStatusNotifier);
