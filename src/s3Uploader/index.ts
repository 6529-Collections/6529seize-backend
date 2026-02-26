import { SQSHandler } from 'aws-lambda';
import { fetchMemeLabNFTByContractAndId, fetchNFTByContractAndId } from '@/db';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import { processS3UploaderJob } from '@/s3';
import * as sentryContext from '@/sentry.context';
import {
  parseS3UploaderJob,
  S3UploaderCollectionType
} from '@/s3Uploader/s3-uploader.jobs';

const logger = Logger.get('S3_UPLOADER');

const sqsHandler: SQSHandler = async (event) => {
  if (process.env.NODE_ENV !== 'production') {
    logger.info(`[SKIPPING] [CONFIG ${process.env.NODE_ENV}]`);
    return;
  }

  await doInDbContext(
    async () => {
      for (const record of event.Records) {
        const job = parseS3UploaderJob(record.body);
        if (!job) {
          logger.warn(`Invalid S3 uploader job payload, skipping`);
          continue;
        }

        const nft =
          job.collectionType === S3UploaderCollectionType.MEME_LAB
            ? await fetchMemeLabNFTByContractAndId(job.contract, job.tokenId)
            : await fetchNFTByContractAndId(job.contract, job.tokenId);

        if (!nft) {
          logger.warn(
            `NFT not found for S3 uploader job [${job.collectionType}] ${job.contract}#${job.tokenId}`
          );
          continue;
        }

        await processS3UploaderJob(nft, job);
      }
    },
    { logger }
  );
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
