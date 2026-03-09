import { SQSBatchResponse, SQSHandler } from 'aws-lambda';
import { fetchMemeLabNFTByContractAndId, fetchNFTByContractAndId } from '@/db';
import { Logger } from '@/logging';
import * as priorityAlertsContext from '@/priority-alerts.context';
import { doInDbContext } from '@/secrets';
import { processS3UploaderJob } from '@/s3';
import * as sentryContext from '@/sentry.context';
import { isS3UploaderEnabledForEnvironment } from '@/s3Uploader/s3-uploader.queue';
import {
  parseS3UploaderJob,
  S3UploaderCollectionType
} from '@/s3Uploader/s3-uploader.jobs';

const logger = Logger.get('S3_UPLOADER');
const ALERT_TITLE = 'S3 Uploader';
const S3_UPLOADER_FAILURE_ALERT_THRESHOLD = 1;

const sqsHandler: SQSHandler = async (event) => {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  let failedRecords = 0;
  let skippedRecords = 0;
  let processedRecords = 0;

  await doInDbContext(
    priorityAlertsContext.wrapAsyncFunction(ALERT_TITLE, async () => {
      if (!isS3UploaderEnabledForEnvironment()) {
        logger.info(`[SKIPPING] [CONFIG ${process.env.NODE_ENV}]`);
        return;
      }

      for (const record of event.Records) {
        const messageId = record.messageId ?? 'unknown';
        logger.info(
          `[RECORD START] [messageId=${messageId}] [bodyLength=${record.body?.length ?? 0}]`
        );
        try {
          const job = parseS3UploaderJob(record.body);
          if (!job) {
            logger.warn(
              `Invalid S3 uploader job payload, skipping [messageId=${messageId}] [body=${truncateRecordBody(
                record.body
              )}]`
            );
            skippedRecords++;
            continue;
          }
          logger.info(
            `[JOB PARSED] [messageId=${messageId}] [reason=${job.reason}] [collection=${job.collectionType}] [contract=${job.contract}] [tokenId=${job.tokenId}] [jobType=${job.jobType}] [variants=${job.variants.join(',')}]`
          );

          const nft =
            job.collectionType === S3UploaderCollectionType.MEME_LAB
              ? await fetchMemeLabNFTByContractAndId(job.contract, job.tokenId)
              : await fetchNFTByContractAndId(job.contract, job.tokenId);

          if (!nft) {
            logger.warn(
              `NFT not found for S3 uploader job [messageId=${messageId}] [${job.collectionType}] ${job.contract}#${job.tokenId}`
            );
            skippedRecords++;
            continue;
          }

          logger.info(
            `[JOB PROCESSING] [messageId=${messageId}] [contract=${job.contract}] [tokenId=${job.tokenId}] [jobType=${job.jobType}]`
          );
          await processS3UploaderJob(nft, job);
          processedRecords++;
          logger.info(
            `[JOB PROCESSED] [messageId=${messageId}] [contract=${job.contract}] [tokenId=${job.tokenId}] [jobType=${job.jobType}]`
          );
        } catch (error: any) {
          logger.error(
            `Failed processing S3 uploader record [messageId=${messageId}]`,
            error
          );
          failedRecords++;
          if (record.messageId) {
            batchItemFailures.push({ itemIdentifier: record.messageId });
          }
        }
      }
      logger.info(
        `[BATCH SUMMARY] [records=${event.Records.length}] [processed=${processedRecords}] [skipped=${skippedRecords}] [failed=${failedRecords}]`
      );

      if (failedRecords >= S3_UPLOADER_FAILURE_ALERT_THRESHOLD) {
        await priorityAlertsContext.sendPriorityAlertIfConfigured(
          ALERT_TITLE,
          new Error(
            `S3 uploader record failures reached threshold [failed=${failedRecords}] [threshold=${S3_UPLOADER_FAILURE_ALERT_THRESHOLD}]`
          )
        );
      }
    }),
    { logger }
  );

  return {
    batchItemFailures
  };
};

function truncateRecordBody(body: string | undefined): string {
  if (!body) {
    return '';
  }
  const maxLength = 300;
  return body.length <= maxLength ? body : `${body.slice(0, maxLength)}...`;
}

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
