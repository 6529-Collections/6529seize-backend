import { attachmentsProcessingService } from '@/attachments/attachments-processing.service';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import type { SQSBatchResponse, SQSHandler } from 'aws-lambda';

const logger = Logger.get('ATTACHMENTS_PROCESSOR');

function parseRecordBody(body: string): { attachment_id: string } {
  const parsed = JSON.parse(body) as { attachment_id?: unknown };
  const attachmentId =
    typeof parsed.attachment_id === 'string' ? parsed.attachment_id.trim() : '';
  if (!attachmentId) {
    throw new Error(`Invalid attachment processing payload: ${body}`);
  }
  return { attachment_id: attachmentId };
}

const sqsHandler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  await doInDbContext(
    async () => {
      for (const record of event.Records) {
        try {
          const message = parseRecordBody(record.body);
          await attachmentsProcessingService.processAttachment(
            message.attachment_id
          );
        } catch (error) {
          logger.error(
            `Failed processing attachment record ${record.messageId}`,
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

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
