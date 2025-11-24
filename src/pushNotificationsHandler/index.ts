import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { IdentityNotificationEntity } from '../entities/IIdentityNotification';
import { DropEntity, DropPartEntity } from '../entities/IDrop';
import { PushNotificationDevice } from '../entities/IPushNotification';
import { SQSBatchResponse, SQSHandler } from 'aws-lambda';
import { sendIdentityNotification } from './identityPushNotifications';
import { WaveEntity } from '../entities/IWave';

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER');

const sqsHandler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  logger.info(`Received ${event.Records.length} messages`);

  const failedItems: { itemIdentifier: string }[] = [];

  await doInDbContext(
    async () => {
      await Promise.all(
        event.Records.map(async (record) => {
          try {
            const messageBody = record.body;
            await processNotification(messageBody);
          } catch (err) {
            logger.error('Failed processing record', {
              error: err,
              messageId: record.messageId
            });
            failedItems.push({ itemIdentifier: record.messageId });
          }
        })
      );
    },
    {
      logger,
      entities: [
        IdentityNotificationEntity,
        PushNotificationDevice,
        WaveEntity,
        DropEntity,
        DropPartEntity
      ]
    }
  );

  return { batchItemFailures: failedItems };
};

const processNotification = async (messageBody: string) => {
  const notification = JSON.parse(messageBody);
  if (notification.identity_notification_id) {
    await sendIdentityNotification(notification.identity_notification_id);
    return;
  }

  logger.warn(`Unknown notification type: ${messageBody}`);
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
