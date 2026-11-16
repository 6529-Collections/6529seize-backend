import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

export const PUSH_NOTIFICATIONS_QUEUE_NAME = 'firebase-push-notifications';

let queueUrlLookup: Promise<string> | null = null;

async function lookUpQueueUrl(sqs: SQSClient): Promise<string> {
  const { QueueUrl } = await sqs.send(
    new GetQueueUrlCommand({ QueueName: PUSH_NOTIFICATIONS_QUEUE_NAME })
  );
  if (!QueueUrl) {
    throw new Error(
      `SQS returned no URL for queue ${PUSH_NOTIFICATIONS_QUEUE_NAME}`
    );
  }
  return QueueUrl;
}

/**
 * The push queue in the account and region this process runs in, so no AWS
 * account ID is hardcoded. The URL is looked up once per process; a failed
 * lookup is not cached and is retried by the next send.
 */
export function getPushNotificationsQueueUrl(sqs: SQSClient): Promise<string> {
  if (!queueUrlLookup) {
    const lookup = lookUpQueueUrl(sqs);
    queueUrlLookup = lookup;
    lookup.catch(() => {
      if (queueUrlLookup === lookup) queueUrlLookup = null;
    });
  }
  return queueUrlLookup;
}
