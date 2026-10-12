import { SQSRecord } from 'aws-lambda';
import { Logger } from '@/logging';
import { ImageSourceUnavailableError } from '@/media/image-download';
import { OperationalDiagnostic } from '@/operational-errors';
import { S3UploaderJob } from './s3-uploader.jobs';

const logger = Logger.get('S3_UPLOADER');

function positiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1000
    ? parsed
    : undefined;
}

function recoveryState(
  attempt: number | undefined,
  maxAttempts: number | undefined
): 'pending' | 'exhausted' | 'unknown' {
  if (!attempt || !maxAttempts) return 'unknown';
  // maxReceiveCount is the source queue's delivery budget. At the limit,
  // a failed delivery must escalate before SQS moves the message to its DLQ.
  return attempt < maxAttempts ? 'pending' : 'exhausted';
}

/** Returns whether the failure also needs the existing urgent priority alert. */
export function reportS3UploaderFailure(
  error: unknown,
  record: Pick<SQSRecord, 'messageId' | 'attributes'>,
  job: S3UploaderJob | null
): boolean {
  if (!(error instanceof ImageSourceUnavailableError)) {
    logger.error(
      `Failed processing S3 uploader record [messageId=${record.messageId}]`,
      error
    );
    return true;
  }
  const attempt = positiveInt(record.attributes?.ApproximateReceiveCount);
  const maxAttempts = positiveInt(process.env.S3_UPLOADER_MAX_RECEIVE_COUNT);
  const state = recoveryState(attempt, maxAttempts);
  const diagnostic: OperationalDiagnostic = {
    category: error.failure.category,
    operation: `S3_IMAGE_DOWNLOAD_${error.failure.reason}`,
    resource: job ? `${job.contract}:${job.tokenId}` : undefined,
    httpStatus:
      error.failure.category === 'HTTP_ERROR'
        ? error.failure.httpStatus
        : undefined,
    recovery: { state, attempt, maxAttempts }
  };
  logger.errorWithDiagnostic(
    diagnostic,
    `Image source unavailable [messageId=${record.messageId}] ` +
      `[asset=${diagnostic.resource ?? 'unknown'}] [recovery=${state}] ` +
      `[receive=${attempt ?? 'unknown'}/${maxAttempts ?? 'unknown'}]: ${error.message}`
  );
  return state !== 'pending';
}
