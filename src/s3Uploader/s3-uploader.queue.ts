import { Logger } from '@/logging';
import { sqs } from '@/sqs';
import {
  buildS3UploaderJobsForNft,
  QueueableNft,
  S3_UPLOADER_QUEUE_NAME,
  S3UploaderCollectionType
} from '@/s3Uploader/s3-uploader.jobs';

const logger = Logger.get('S3_UPLOADER_QUEUE');

export function isS3UploaderEnabledForEnvironment() {
  return process.env.NODE_ENV === 'production';
}

export async function enqueueS3UploaderJobsForNft({
  nft,
  collectionType,
  reason
}: {
  nft: QueueableNft;
  collectionType: S3UploaderCollectionType;
  reason: 'discover' | 'refresh' | 'audit';
}) {
  if (!isS3UploaderEnabledForEnvironment()) {
    logger.info(
      `[SKIPPING ENQUEUE] [CONFIG ${process.env.NODE_ENV}] [NFT ${nft.contract}#${nft.id}]`
    );
    return;
  }

  const jobs = buildS3UploaderJobsForNft({ nft, collectionType, reason });
  for (const job of jobs) {
    await sqs.sendToQueueName({
      queueName: S3_UPLOADER_QUEUE_NAME,
      message: job
    });
  }
}
