import {
  ChangeMessageVisibilityCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient
} from '@aws-sdk/client-sqs';
import type { SQSRecord } from 'aws-lambda';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { Logger } from '@/logging';

export interface ForgeDelivery {
  id: string;
  revision: number;
  step?: number;
}
export const forgeQueueName = (preparation = false) =>
  preparation ? 'memes-distribution' : 'drop-forge-launch';
const sqs = new SQSClient({});
export async function forgeQueueUrl(preparation = false): Promise<string> {
  const result = await sqs.send(
    new GetQueueUrlCommand({ QueueName: forgeQueueName(preparation) })
  );
  if (!result.QueueUrl)
    throw new LaunchSafetyError('Operations queue is unavailable');
  return result.QueueUrl;
}
// Publish under the SQL lock before committing the new revision. Early
// delivery retries; a rejected publish rolls back the requested mutation.
export async function wakeDropForge(
  delivery: ForgeDelivery,
  preparation = false,
  delay = 1
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: await forgeQueueUrl(preparation),
      MessageBody: JSON.stringify(delivery),
      DelaySeconds: delay
    })
  );
}
export async function consumeForgeDelivery(
  record: SQSRecord,
  preparation: boolean,
  run: (delivery: ForgeDelivery) => Promise<void>
): Promise<void> {
  try {
    await run(parseForgeDelivery(record.body));
  } catch (error) {
    // Do not leave an early delivery invisible for the full timeout while its
    // publishing transaction commits. Hard crashes have a separate watchdog.
    try {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: await forgeQueueUrl(preparation),
          ReceiptHandle: record.receiptHandle,
          VisibilityTimeout: 30
        })
      );
    } catch {
      Logger.get('DROP_FORGE_QUEUE').warn(
        'Could not shorten queue retry; original delivery remains durable'
      );
    }
    throw error;
  }
}
export function parseForgeDelivery(body: string): ForgeDelivery {
  const value = JSON.parse(body) as ForgeDelivery;
  if (
    !value ||
    typeof value.id !== 'string' ||
    !value.id.length ||
    value.id.length > 100 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    throw new LaunchSafetyError('Invalid operations delivery');
  if (
    value.step !== undefined &&
    (!Number.isSafeInteger(value.step) || value.step < 0)
  )
    throw new LaunchSafetyError('Invalid preparation checkpoint');
  return {
    id: value.id,
    revision: value.revision,
    ...(value.step === undefined ? {} : { step: value.step })
  };
}
