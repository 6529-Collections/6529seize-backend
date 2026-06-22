import { DROP_MEDIA_SANITIZER_QUEUE_NAME } from '@/drops/drop-media-upload.config';
import { sqs } from '@/sqs';

export async function enqueueDropMediaSanitization({
  mediaUploadId
}: {
  mediaUploadId: string;
}): Promise<void> {
  await sqs.sendToQueueName({
    queueName:
      process.env.DROP_MEDIA_SANITIZER_SQS_QUEUE_NAME ??
      DROP_MEDIA_SANITIZER_QUEUE_NAME,
    message: {
      media_upload_id: mediaUploadId
    }
  });
}
