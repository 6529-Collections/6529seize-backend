import {
  SQSClient,
  SendMessageCommand,
  SendMessageCommandInput
} from '@aws-sdk/client-sqs';
import { Logger } from '../../../logging';

const logger = Logger.get('PUSH_NOTIFICATIONS');
logger.info(`i am process.env.AWS_REGION: ${process.env.AWS_REGION}`);
const region = process.env.AWS_REGION || 'eu-west-1';
logger.info(`i am region: ${region}`);

const sqs = new SQSClient({ region });

export const sendIdentityPushNotification = async (notificationId: number) => {
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

export const sendMessageToSQS = async (messageBody: string) => {
  const params: SendMessageCommandInput = {
    QueueUrl: `https://sqs.${region}.amazonaws.com/987989283142/firebase-push-notifications`,
    MessageBody: messageBody
  };

  const command = new SendMessageCommand(params);
  const response = await sqs.send(command);
  logger.info('Message sent:', response.MessageId);
};