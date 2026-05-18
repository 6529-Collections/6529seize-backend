import { SQSBatchResponse, SQSHandler } from 'aws-lambda';
import {
  AttachmentEntity,
  DropAttachmentEntity
} from '../entities/IAttachment';
import { DropEntity, DropMediaEntity, DropPartEntity } from '../entities/IDrop';
import { IdentityNotificationEntity } from '../entities/IIdentityNotification';
import { PushNotificationDevice } from '../entities/IPushNotification';
import { PushNotificationSettingsEntity } from '../entities/IPushNotificationSettings';
import { WaveEntity } from '../entities/IWave';
import { WaveReaderMetricEntity } from '../entities/IWaveReaderMetric';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { sendIdentityNotificationsBatch } from '@/pushNotificationsHandler/identityPushNotifications';

const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER');

const sqsHandler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  return doInDbContext(
    async () => {
      const identityNotificationRecords: {
        messageId: string;
        identityNotificationId: number;
      }[] = [];
      const failures: { itemIdentifier: string }[] = [];

      for (const record of event.Records) {
        try {
          const notification = JSON.parse(record.body);
          if (notification.identity_notification_id) {
            identityNotificationRecords.push({
              messageId: record.messageId,
              identityNotificationId: notification.identity_notification_id
            });
          } else {
            logger.warn(`Unknown notification type: ${record.body}`);
          }
        } catch (error) {
          logger.error(
            `Failed to parse push notification message ${record.messageId}: ${error}`
          );
          failures.push({ itemIdentifier: record.messageId });
        }
      }

      if (identityNotificationRecords.length) {
        const failedNotificationIds = await sendIdentityNotificationsBatch(
          identityNotificationRecords.map(
            (record) => record.identityNotificationId
          )
        );
        const failedNotificationIdSet = new Set(failedNotificationIds);
        failures.push(
          ...identityNotificationRecords
            .filter((record) =>
              failedNotificationIdSet.has(record.identityNotificationId)
            )
            .map((record) => ({
              itemIdentifier: record.messageId
            }))
        );
      }

      return {
        batchItemFailures: failures
      };
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
        DropMediaEntity,
        DropPartEntity,
        AttachmentEntity,
        DropAttachmentEntity
      ]
    }
  );
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
