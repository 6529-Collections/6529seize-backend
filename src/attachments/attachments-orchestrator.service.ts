import { GetObjectTaggingCommand } from '@aws-sdk/client-s3';
import { attachmentsDb, AttachmentsDb } from '@/attachments/attachments.db';
import { enqueueAttachmentOrchestrationRetry } from '@/attachments/attachments-orchestration-publisher';
import { enqueueAttachmentProcessing } from '@/attachments/attachments-processing-publisher';
import {
  attachmentsStatusNotifier,
  AttachmentsStatusNotifier
} from '@/attachments/attachments-status-notifier';
import { AttachmentEntity, AttachmentStatus } from '@/entities/IAttachment';
import { Logger } from '@/logging';
import { getAttachmentsS3 } from '@/attachments/attachments-s3-client';
import { Time } from '@/time';

const GUARDDUTY_STATUS_TAG = 'GuardDutyMalwareScanStatus';
const MAX_GUARDDUTY_POLL_ATTEMPTS = 20;

type FinalGuardDutyStatus =
  | 'NO_THREATS_FOUND'
  | 'THREATS_FOUND'
  | 'UNSUPPORTED'
  | 'ACCESS_DENIED'
  | 'FAILED';

type OrchestrationRequest = {
  attachmentId?: string;
  originalBucket: string;
  originalKey: string;
  lookupAttempt: number;
  uploadAttempt: number;
  scanAttempt: number;
};

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
      lookupAttempt: 0,
      uploadAttempt: 0,
      scanAttempt: 0
    });
  }

  public async handleRetryMessage({
    attachmentId,
    originalBucket,
    originalKey,
    lookupAttempt = 0,
    uploadAttempt,
    scanAttempt
  }: {
    attachmentId: string;
    originalBucket: string;
    originalKey: string;
    lookupAttempt?: number;
    uploadAttempt: number;
    scanAttempt: number;
  }): Promise<void> {
    await this.orchestrate({
      attachmentId,
      originalBucket,
      originalKey,
      lookupAttempt,
      uploadAttempt,
      scanAttempt
    });
  }

  private async orchestrate(request: OrchestrationRequest): Promise<void> {
    const attachment = await this.findAttachment(request);

    if (!attachment) {
      await this.handleMissingAttachment(request);
      return;
    }

    if (this.isFinalOrClaimed(attachment.status)) {
      return;
    }

    if (attachment.status === AttachmentStatus.UPLOADING) {
      await this.handleUploadingAttachment(attachment, request);
      return;
    }

    const guardDutyStatus = await this.getGuardDutyStatus(request);

    if (!guardDutyStatus) {
      await this.handleMissingGuardDutyStatus(attachment, request);
      return;
    }

    if (guardDutyStatus === 'NO_THREATS_FOUND') {
      await this.enqueueCleanAttachment(attachment, guardDutyStatus);
      return;
    }

    if (this.isBlockingGuardDutyStatus(guardDutyStatus)) {
      await this.transitionAndNotify({
        attachment,
        toStatus: AttachmentStatus.BLOCKED,
        patch: {
          guardduty_status: guardDutyStatus,
          verdict: `MALWARE_SCAN_${guardDutyStatus}`,
          error_reason: `GuardDuty blocked attachment (${guardDutyStatus})`
        }
      });
      return;
    }

    await this.transitionAndNotify({
      attachment,
      toStatus: AttachmentStatus.FAILED,
      patch: {
        guardduty_status: guardDutyStatus,
        verdict: `MALWARE_SCAN_${guardDutyStatus}`,
        error_reason: `GuardDuty scan failed (${guardDutyStatus})`
      }
    });
  }

  private async findAttachment({
    attachmentId,
    originalBucket,
    originalKey
  }: OrchestrationRequest): Promise<AttachmentEntity | null> {
    return attachmentId
      ? await this.attachmentsDb.findAttachmentById(attachmentId)
      : await this.attachmentsDb.findAttachmentByOriginalLocation({
          originalBucket,
          originalKey
        });
  }

  private async handleMissingAttachment({
    attachmentId,
    originalBucket,
    originalKey,
    lookupAttempt,
    uploadAttempt,
    scanAttempt
  }: OrchestrationRequest): Promise<void> {
    if (lookupAttempt >= MAX_GUARDDUTY_POLL_ATTEMPTS) {
      throw new Error(
        `Attachment row not found for ${originalBucket}/${originalKey} after ${lookupAttempt} attempts`
      );
    }
    await enqueueAttachmentOrchestrationRetry({
      attachmentId: attachmentId ?? '',
      originalBucket,
      originalKey,
      lookupAttempt: lookupAttempt + 1,
      uploadAttempt,
      scanAttempt,
      delaySeconds: this.getRetryDelaySeconds(lookupAttempt)
    });
  }

  private isFinalOrClaimed(status: AttachmentStatus): boolean {
    return [
      AttachmentStatus.READY,
      AttachmentStatus.BLOCKED,
      AttachmentStatus.FAILED,
      AttachmentStatus.PROCESSING
    ].includes(status);
  }

  private async handleUploadingAttachment(
    attachment: AttachmentEntity,
    request: OrchestrationRequest
  ): Promise<void> {
    if (request.uploadAttempt >= MAX_GUARDDUTY_POLL_ATTEMPTS) {
      await this.transitionAndNotify({
        attachment,
        fromStatus: AttachmentStatus.UPLOADING,
        toStatus: AttachmentStatus.FAILED,
        patch: {
          verdict: 'UPLOAD_COMPLETION_TIMEOUT',
          error_reason: 'Attachment completion did not finalize in time'
        }
      });
      return;
    }
    await enqueueAttachmentOrchestrationRetry({
      attachmentId: attachment.id,
      originalBucket: request.originalBucket,
      originalKey: request.originalKey,
      lookupAttempt: request.lookupAttempt,
      uploadAttempt: request.uploadAttempt + 1,
      scanAttempt: request.scanAttempt,
      delaySeconds: this.getRetryDelaySeconds(request.uploadAttempt)
    });
  }

  private async handleMissingGuardDutyStatus(
    attachment: AttachmentEntity,
    request: OrchestrationRequest
  ): Promise<void> {
    if (request.scanAttempt >= MAX_GUARDDUTY_POLL_ATTEMPTS) {
      await this.transitionAndNotify({
        attachment,
        toStatus: AttachmentStatus.FAILED,
        patch: {
          verdict: 'MALWARE_SCAN_TIMEOUT',
          error_reason: 'GuardDuty scan result was not available in time'
        }
      });
      return;
    }
    await enqueueAttachmentOrchestrationRetry({
      attachmentId: attachment.id,
      originalBucket: request.originalBucket,
      originalKey: request.originalKey,
      lookupAttempt: request.lookupAttempt,
      uploadAttempt: request.uploadAttempt,
      scanAttempt: request.scanAttempt + 1,
      delaySeconds: this.getRetryDelaySeconds(request.scanAttempt)
    });
  }

  private async enqueueCleanAttachment(
    attachment: AttachmentEntity,
    guardDutyStatus: FinalGuardDutyStatus
  ): Promise<void> {
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
  }

  private isBlockingGuardDutyStatus(status: FinalGuardDutyStatus): boolean {
    return status === 'THREATS_FOUND' || status === 'UNSUPPORTED';
  }

  private async transitionAndNotify({
    attachment,
    fromStatus = AttachmentStatus.VERIFYING,
    toStatus,
    patch
  }: {
    attachment: AttachmentEntity;
    fromStatus?: AttachmentStatus;
    toStatus: AttachmentStatus;
    patch: {
      guardduty_status?: FinalGuardDutyStatus;
      verdict: string;
      error_reason: string;
    };
  }): Promise<void> {
    const updatedAt = Time.currentMillis();
    const transitioned = await this.attachmentsDb.transitionAttachmentStatus({
      id: attachment.id,
      fromStatus,
      toStatus,
      updatedAt,
      patch
    });
    if (!transitioned) {
      return;
    }
    await this.statusNotifier.notifyStatusTransition({
      ...attachment,
      ...patch,
      status: toStatus,
      updated_at: updatedAt
    });
  }

  private async getGuardDutyStatus({
    originalBucket,
    originalKey
  }: {
    originalBucket: string;
    originalKey: string;
  }): Promise<FinalGuardDutyStatus | null> {
    const response = await getAttachmentsS3().send(
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
