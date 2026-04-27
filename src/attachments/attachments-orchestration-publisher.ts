import { Logger } from '@/logging';
import { sqs } from '@/sqs';
import { ATTACHMENTS_ORCHESTRATION_QUEUE_NAME } from '@/attachments/attachments-queues';

const logger = Logger.get('attachments-orchestration-publisher');

export async function enqueueAttachmentOrchestrationRetry({
  attachmentId,
  originalBucket,
  originalKey,
  attempt,
  delaySeconds
}: {
  attachmentId: string;
  originalBucket: string;
  originalKey: string;
  attempt: number;
  delaySeconds: number;
}): Promise<void> {
  await sqs.sendToQueueName({
    queueName: ATTACHMENTS_ORCHESTRATION_QUEUE_NAME,
    message: {
      attachment_id: attachmentId,
      original_bucket: originalBucket,
      original_key: originalKey,
      attempt
    },
    delaySeconds
  });
  logger.info(
    `Queued attachment orchestration retry attachment_id=${attachmentId} attempt=${attempt} delaySeconds=${delaySeconds}`
  );
}
