import { withMediaDependencySmoke } from '@/media/media-dependency-smoke';
import { dropMediaSanitizerService } from '@/drops/drop-media-sanitizer.service';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import type { SQSBatchResponse, SQSHandler } from 'aws-lambda';

const logger = Logger.get('DROP_MEDIA_SANITIZER');

function parseRecordBody(body: string): {
  media_upload_id: string;
  retry_failed: boolean;
} {
  const parsed = JSON.parse(body) as {
    media_upload_id?: unknown;
    retry_failed?: unknown;
  };
  const mediaUploadId =
    typeof parsed.media_upload_id === 'string'
      ? parsed.media_upload_id.trim()
      : '';
  if (
    !mediaUploadId ||
    (parsed.retry_failed !== undefined &&
      typeof parsed.retry_failed !== 'boolean')
  ) {
    throw new Error(`Invalid drop media sanitizer payload: ${body}`);
  }
  return {
    media_upload_id: mediaUploadId,
    retry_failed: parsed.retry_failed === true
  };
}

function getApproximateReceiveCount(record: {
  attributes?: { ApproximateReceiveCount?: string };
}): number {
  const count = Number(record.attributes?.ApproximateReceiveCount ?? '1');
  return Number.isInteger(count) && count > 0 ? count : 1;
}

const sqsHandler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  await doInDbContext(
    async () => {
      for (const record of event.Records) {
        try {
          const message = parseRecordBody(record.body);
          await dropMediaSanitizerService.processUpload({
            mediaUploadId: message.media_upload_id,
            retryFailed: message.retry_failed,
            approximateReceiveCount: getApproximateReceiveCount(record)
          });
        } catch (error) {
          logger.error(
            `Failed processing drop media sanitizer record ${record.messageId}`,
            error
          );
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }
    },
    { logger }
  );
  return { batchItemFailures };
};

export const handler = withMediaDependencySmoke(
  sentryContext.wrapLambdaHandler(sqsHandler)
);
