import { randomInt } from 'node:crypto';
import { ChangeMessageVisibilityCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SQSRecord } from 'aws-lambda';

export function retryDelaySeconds(receiveCount: string): number {
  const count = Number(receiveCount);
  const attempt = Number.isSafeInteger(count) && count > 0 ? count : 1;
  const ceiling = Math.min(60, 2 ** Math.min(attempt, 6));
  return randomInt(1, ceiling + 1);
}

let client: SQSClient | undefined;
export async function deferWebSocketRetry(record: SQSRecord): Promise<void> {
  const queueUrl = process.env.WS_OUTBOUND_QUEUE_URL;
  if (!queueUrl) throw new Error('Missing outbound queue URL');
  client ??= new SQSClient({});
  await client.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: record.receiptHandle,
      VisibilityTimeout: retryDelaySeconds(
        record.attributes.ApproximateReceiveCount
      )
    })
  );
}
