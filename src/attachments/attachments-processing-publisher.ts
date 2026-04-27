import { Logger } from '@/logging';
import { sqs } from '@/sqs';
import { ATTACHMENTS_PROCESSING_QUEUE_NAME } from '@/attachments/attachments-queues';

const logger = Logger.get('attachments-processing-publisher');

export async function enqueueAttachmentProcessing(
  attachmentId: string
): Promise<void> {
  await sqs.sendToQueueName({
    queueName: ATTACHMENTS_PROCESSING_QUEUE_NAME,
    message: {
      attachment_id: attachmentId
    }
  });
  logger.info(`Queued attachment processing attachment_id=${attachmentId}`);
}
