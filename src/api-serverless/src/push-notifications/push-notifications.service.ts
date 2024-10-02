import {
  SQSClient,
  SendMessageCommand,
  SendMessageCommandInput
} from '@aws-sdk/client-sqs';
import { Logger } from '../../../logging';

const logger = Logger.get('PUSH_NOTIFICATIONS');
const region = process.env.AWS_REGION;
logger.info(`REGION: ${region}`);

const sqs = new SQSClient({ region });

const isActivated = process.env.PUSH_NOTIFICATIONS_ACTIVATED === 'true';

export const sendIdentityPushNotification = async (notificationId: number) => {
  if (!isActivated) {
    logger.info('Push notifications are not activated');
    return;
  }
  try {
    const message = {
      identity_id: notificationId
    };
    await sendMessageToSQS(JSON.stringify(message));
  } catch (error) {
    logger.error(
      `[ID ${notificationId}] Error sending push notification: ${error}`
    );
  }
};

const sendMessageToSQS = async (messageBody: string) => {
  const params: SendMessageCommandInput = {
    QueueUrl: `https://sqs.${region}.amazonaws.com/987989283142/firebase-push-notifications`,
    MessageBody: messageBody
  };

  const command = new SendMessageCommand(params);
  const response = await sqs.send(command);
  logger.info(`Message sent: ${response.MessageId}`);
};
