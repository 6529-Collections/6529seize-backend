import { reportPushDeliveryFailure } from '@/pushNotificationsHandler/push-send-diagnostics';
import { PushInstallationEntity } from '@/entities/IPushInstallation';
import {
  refreshInstallationBadge,
  refreshProfileBadges
} from './badge-refresh';
import { SQSBatchResponse, SQSEvent, ScheduledEvent } from 'aws-lambda';
import { publishPushOutbox } from '@/pushNotificationsHandler/publish-outbox';
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

async function refreshInstallationRecords(
  records: { messageId: string; deviceId: string }[]
): Promise<{ itemIdentifier: string }[]> {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of records) {
    try {
      await refreshInstallationBadge(record.deviceId);
    } catch (error) {
      reportPushDeliveryFailure(error, 'installation_badge_refresh');
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return failures;
}

const sqsHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  return doInDbContext(
    async () => {
      const identityNotificationRecords: {
        messageId: string;
        identityNotificationId: number;
      }[] = [];
      const badgeRecords: { messageId: string; profileId: string }[] = [];
      const installationRecords: { messageId: string; deviceId: string }[] = [];
      const failures: { itemIdentifier: string }[] = [];

      for (const record of event.Records) {
        try {
          const notification = JSON.parse(record.body);
          if (
            notification.type === 'badge_refresh' &&
            typeof notification.profile_id === 'string' &&
            notification.profile_id.trim()
          ) {
            badgeRecords.push({
              messageId: record.messageId,
              profileId: notification.profile_id
            });
          } else if (
            notification.type === 'installation_badge_refresh' &&
            typeof notification.device_id === 'string' &&
            notification.device_id.trim()
          ) {
            installationRecords.push({
              messageId: record.messageId,
              deviceId: notification.device_id
            });
          } else if (notification.identity_notification_id) {
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

      if (badgeRecords.length) {
        try {
          const failedProfiles = new Set(
            await refreshProfileBadges(
              badgeRecords.map((record) => record.profileId)
            )
          );
          failures.push(
            ...badgeRecords
              .filter((record) => failedProfiles.has(record.profileId))
              .map((record) => ({ itemIdentifier: record.messageId }))
          );
        } catch (error) {
          reportPushDeliveryFailure(error, 'badge_refresh');
          failures.push(
            ...badgeRecords.map((record) => ({
              itemIdentifier: record.messageId
            }))
          );
        }
      }

      failures.push(...(await refreshInstallationRecords(installationRecords)));
      const failed = new Set(failures.map((item) => item.itemIdentifier));
      if (
        event.Records.some(
          (record) =>
            failed.has(record.messageId) &&
            Number(record.attributes?.ApproximateReceiveCount) >= 8
        )
      ) {
        const error = new Error(
          'Push work is approaching its queue retry limit'
        );
        error.name = 'PushRetry.NEAR_EXHAUSTION';
        logger.errorWithCode('PUSH_RETRY_EXHAUSTED', error.message, error);
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
        PushInstallationEntity,
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

export async function dispatchPushEvent(
  event: SQSEvent | ScheduledEvent
): Promise<SQSBatchResponse> {
  if ('Records' in event) return sqsHandler(event);
  if (
    event.source !== 'aws.events' ||
    event['detail-type'] !== 'Scheduled Event'
  ) {
    throw new Error('Unsupported push handler event');
  }
  await doInDbContext(publishPushOutbox, { logger });
  return { batchItemFailures: [] };
}

export const handler = sentryContext.wrapLambdaHandler(dispatchPushEvent);
