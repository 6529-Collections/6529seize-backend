import {
  SQSClient,
  SendMessageBatchCommand,
  SendMessageBatchCommandInput
} from '@aws-sdk/client-sqs';
import { Logger } from '../../../logging';

const logger = Logger.get('PUSH_NOTIFICATIONS');
const region = process.env.AWS_REGION;

const sqs = new SQSClient({ region });

export function isActivated() {
  return !!process.env.PUSH_NOTIFICATIONS_ACTIVATED;
}

export const sendIdentityPushNotification = async (id: number) => {
  await sendIdentityPushNotifications([id]);
};

export const sendIdentityPushNotifications = async (ids: number[]) => {
  if (!isActivated()) {
    logger.info('Push notifications are not activated');
    return;
  }
  const uniqueIds = Array.from(new Set(ids));
  if (!uniqueIds.length) {
    return;
  }

  const batchSize = 10;
  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const chunk = uniqueIds.slice(i, i + batchSize);
    try {
      await sendBatchMessagesToSQS(
        chunk.map((id) => ({
          Id: `identity-notification-${id}`,
          MessageBody: JSON.stringify({
            identity_notification_id: id
          })
        }))
      );
    } catch (error) {
      logger.error(
        `[IDENTITY NOTIFICATION IDS ${chunk.join(',')}] Error sending push notification chunk from ${uniqueIds.join(',')}: ${error}`
      );
    }
  }
};

const sendBatchMessagesToSQS = async (
  entries: NonNullable<SendMessageBatchCommandInput['Entries']>
) => {
  const params: SendMessageBatchCommandInput = {
    QueueUrl: `https://sqs.${region}.amazonaws.com/987989283142/firebase-push-notifications`,
    Entries: entries
  };

  const command = new SendMessageBatchCommand(params);
  const response = await sqs.send(command);
  if (response.Failed?.length) {
    throw new Error(
      `Failed to enqueue push notifications: ${response.Failed.map((item) => item.Id).join(', ')}`
    );
  }
};
