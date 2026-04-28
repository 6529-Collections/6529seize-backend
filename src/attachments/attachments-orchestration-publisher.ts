import { Logger } from '@/logging';
import { sqs } from '@/sqs';
import { ATTACHMENTS_ORCHESTRATION_QUEUE_NAME } from '@/attachments/attachments-queues';

const logger = Logger.get('attachments-orchestration-publisher');

export async function enqueueAttachmentOrchestrationRetry({
  attachmentId,
  originalBucket,
  originalKey,
  uploadAttempt,
  scanAttempt,
  delaySeconds
}: {
  attachmentId: string;
  originalBucket: string;
  originalKey: string;
  uploadAttempt: number;
  scanAttempt: number;
  delaySeconds: number;
}): Promise<void> {
  await sqs.sendToQueueName({
    queueName: ATTACHMENTS_ORCHESTRATION_QUEUE_NAME,
    message: {
      attachment_id: attachmentId,
      original_bucket: originalBucket,
      original_key: originalKey,
      upload_attempt: uploadAttempt,
      scan_attempt: scanAttempt
    },
    delaySeconds
  });
  logger.info(
    `Queued attachment orchestration retry attachment_id=${attachmentId} upload_attempt=${uploadAttempt} scan_attempt=${scanAttempt} delaySeconds=${delaySeconds}`
  );
}
