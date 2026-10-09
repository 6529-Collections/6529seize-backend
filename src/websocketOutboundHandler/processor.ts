import { OUTBOX_WAKEUP } from '@/websocket-outbox/wakeup';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import {
  parseQueuedWebSocketFrame,
  QueuedWebSocketFrame
} from '@/api/ws/ws-outbound-queue';

/** Stop at the first failure, retaining it and unprocessed FIFO records. */
export async function processWebSocketBatch(
  event: SQSEvent,
  deliver: (frame: QueuedWebSocketFrame) => Promise<void>,
  reportFailure: () => void,
  deferRetry: (record: SQSRecord) => Promise<void> = () => Promise.resolve(),
  drainOutbox?: () => Promise<void>
): Promise<SQSBatchResponse> {
  for (let index = 0; index < event.Records.length; index++) {
    try {
      const body = event.Records[index]!.body;
      if (JSON.parse(body)?.type === OUTBOX_WAKEUP && drainOutbox)
        await drainOutbox();
      else await deliver(parseQueuedWebSocketFrame(body));
    } catch {
      try {
        reportFailure();
      } catch {
        /* Keep retrying even if reporting fails. */
      }
      try {
        await deferRetry(event.Records[index]!);
      } catch {
        /* Default visibility still retains the message. */
      }
      return {
        batchItemFailures: event.Records.slice(index).map((record) => ({
          itemIdentifier: record.messageId
        }))
      };
    }
  }
  return { batchItemFailures: [] };
}
