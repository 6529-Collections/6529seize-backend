import { attachmentsProcessingService } from '@/attachments/attachments-processing.service';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import type { SQSHandler } from 'aws-lambda';

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

const sqsHandler: SQSHandler = async (event) => {
  await doInDbContext(
    async () => {
      for (const record of event.Records) {
        const message = parseRecordBody(record.body);
        await attachmentsProcessingService.processAttachment(
          message.attachment_id
        );
      }
    },
    { logger }
  );
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
