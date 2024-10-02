import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { IdentityNotificationEntity } from '../entities/IIdentityNotification';
import { DropPartEntity } from '../entities/IDrop';
import { PushNotificationDevice } from '../entities/IPushNotification';
import { SQSHandler } from 'aws-lambda';
import { sendIdentityNotification } from './identityPushNotifications';

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER');

const sqsHandler: SQSHandler = async (event) => {
  await doInDbContext(
    async () => {
      await Promise.all(
        event.Records.map(async (record) => {
          const messageBody = record.body;
          await processNotification(messageBody);
        })
      );
    },
    {
      logger,
      entities: [
        IdentityNotificationEntity,
        PushNotificationDevice,
        DropPartEntity
      ]
    }
  );
};

const processNotification = async (messageBody: string) => {
  const notification = JSON.parse(messageBody);
  if (notification.identity_id) {
    await sendIdentityNotification(notification.identity_id);
    return;
  }

  logger.warn(`Unknown notification type: ${messageBody}`);
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
