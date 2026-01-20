import { SQSHandler } from 'aws-lambda';
import { DropEntity, DropPartEntity } from '../entities/IDrop';
import { IdentityNotificationEntity } from '../entities/IIdentityNotification';
import { PushNotificationDevice } from '../entities/IPushNotification';
import { PushNotificationSettingsEntity } from '../entities/IPushNotificationSettings';
import { WaveEntity } from '../entities/IWave';
import { WaveReaderMetricEntity } from '../entities/IWaveReaderMetric';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
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
        PushNotificationSettingsEntity,
        WaveEntity,
        WaveReaderMetricEntity,
        DropEntity,
        DropPartEntity
      ]
    }
  );
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
