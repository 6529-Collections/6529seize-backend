import { attachmentsOrchestratorService } from '@/attachments/attachments-orchestrator.service';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import type { EventBridgeEvent, SQSHandler } from 'aws-lambda';

const logger = Logger.get('ATTACHMENTS_ORCHESTRATOR');

type AttachmentOrchestrationRetryPayload = {
  attachment_id: string;
  original_bucket: string;
  original_key: string;
  attempt: number;
};

type S3ObjectCreatedDetail = {
  bucket?: { name?: string };
  object?: { key?: string };
};

function parseRetryPayload(body: string): AttachmentOrchestrationRetryPayload {
  const parsed = JSON.parse(
    body
  ) as Partial<AttachmentOrchestrationRetryPayload>;
  if (
    typeof parsed.attachment_id !== 'string' ||
    typeof parsed.original_bucket !== 'string' ||
    typeof parsed.original_key !== 'string' ||
    typeof parsed.attempt !== 'number'
  ) {
    throw new Error(`Invalid attachment orchestration retry payload: ${body}`);
  }
  return parsed as AttachmentOrchestrationRetryPayload;
}

function normalizeS3ObjectKey(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, ' '));
}

async function handleSqs(event: Parameters<SQSHandler>[0]) {
  await doInDbContext(
    async () => {
      for (const record of event.Records) {
        const payload = parseRetryPayload(record.body);
        await attachmentsOrchestratorService.handleRetryMessage({
          attachmentId: payload.attachment_id,
          originalBucket: payload.original_bucket,
          originalKey: payload.original_key,
          attempt: payload.attempt
        });
      }
    },
    { logger }
  );
}

async function handleEventBridge(
  event: EventBridgeEvent<'Object Created', S3ObjectCreatedDetail>
) {
  const bucket = event.detail.bucket?.name?.trim();
  const key = event.detail.object?.key?.trim();
  if (!bucket || !key) {
    throw new Error(
      `Invalid S3 object created event: ${JSON.stringify(event)}`
    );
  }
  await doInDbContext(
    async () => {
      await attachmentsOrchestratorService.handleObjectCreated({
        originalBucket: bucket,
        originalKey: normalizeS3ObjectKey(key)
      });
    },
    { logger }
  );
}

const handlerImpl = async (event: any): Promise<void> => {
  if (Array.isArray(event?.Records)) {
    await handleSqs(event);
    return;
  }
  await handleEventBridge(event);
};

export const handler = sentryContext.wrapLambdaHandler(handlerImpl);
