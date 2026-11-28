import { reportPushDeliveryFailure } from '@/pushNotificationsHandler/push-send-diagnostics';
import { PushInstallationEntity } from '@/entities/IPushInstallation';
import {
  refreshInstallationBadge,
  refreshProfileBadges
} from './badge-refresh';
import {
  Context,
  SQSBatchResponse,
  SQSEvent,
  SQSRecord,
  ScheduledEvent
} from 'aws-lambda';
import { withBadgeLockDeadline } from './device-badge';
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
import {
  sendIdentityNotificationsBatch,
  sendViewNotificationsBatch
} from '@/pushNotificationsHandler/identityPushNotifications';
import type { ViewNotificationKey } from '@/notifications/view/notification-view-push.db';
import { viewPushKey } from '@/pushNotificationsHandler/push-key';
import {
  E2eeWakeRequest,
  parseE2eeWakeMessage,
  sendE2eeWakes
} from '@/pushNotificationsHandler/e2ee-wake';

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

type E2eeWakeRecord = { messageId: string; wake: E2eeWakeRequest };

/** `{view_notification: {identity_id, source_key}}`, as the outbox publisher writes it. */
function parseViewNotificationKey(value: unknown): ViewNotificationKey | null {
  if (typeof value !== 'object' || value === null) return null;
  const { identity_id, source_key } = value as Record<string, unknown>;
  return typeof identity_id === 'string' &&
    identity_id.trim() &&
    typeof source_key === 'string' &&
    /^[0-9a-f]{64}$/.test(source_key)
    ? { identity_id, source_key }
    : null;
}

function parseE2eeWakeBody(body: string): E2eeWakeRequest | null {
  try {
    return parseE2eeWakeMessage(JSON.parse(body));
  } catch {
    // Not JSON: the main loop reports and retries it like any other record.
    return null;
  }
}

/** Splits content-free E2EE wakes from the other push work in a batch. */
function partitionE2eeWakeRecords(records: SQSRecord[]): {
  wakes: E2eeWakeRecord[];
  others: SQSRecord[];
} {
  const wakes: E2eeWakeRecord[] = [];
  const others: SQSRecord[] = [];
  for (const record of records) {
    const wake = parseE2eeWakeBody(record.body);
    if (wake) wakes.push({ messageId: record.messageId, wake });
    else others.push(record);
  }
  return { wakes, others };
}

async function sendE2eeWakeRecords(
  records: E2eeWakeRecord[]
): Promise<{ itemIdentifier: string }[]> {
  if (!records.length) return [];
  try {
    await sendE2eeWakes(records.map((record) => record.wake));
    return [];
  } catch (error) {
    // Only lookups before any send can fail here; retry those records.
    reportPushDeliveryFailure(error, 'delivery');
    return records.map((record) => ({ itemIdentifier: record.messageId }));
  }
}

const sqsHandler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  return doInDbContext(
    async () => {
      const identityNotificationRecords: {
        messageId: string;
        identityNotificationId: number;
      }[] = [];
      const viewNotificationRecords: {
        messageId: string;
        key: ViewNotificationKey;
      }[] = [];
      const badgeRecords: { messageId: string; profileId: string }[] = [];
      const installationRecords: { messageId: string; deviceId: string }[] = [];
      const { wakes: e2eeWakeRecords, others } = partitionE2eeWakeRecords(
        event.Records
      );
      const failures: { itemIdentifier: string }[] = [];

      for (const record of others) {
        try {
          const notification = JSON.parse(record.body);
          const viewKey = parseViewNotificationKey(
            notification.view_notification
          );
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
          } else if (viewKey) {
            viewNotificationRecords.push({
              messageId: record.messageId,
              key: viewKey
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

      if (viewNotificationRecords.length) {
        const failedKeys = new Set(
          (
            await sendViewNotificationsBatch(
              viewNotificationRecords.map((record) => record.key)
            )
          ).map(viewPushKey)
        );
        failures.push(
          ...viewNotificationRecords
            .filter((record) => failedKeys.has(viewPushKey(record.key)))
            .map((record) => ({ itemIdentifier: record.messageId }))
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

      failures.push(
        ...(await refreshInstallationRecords(installationRecords)),
        ...(await sendE2eeWakeRecords(e2eeWakeRecords))
      );
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
  event: SQSEvent | ScheduledEvent,
  context?: Pick<Context, 'getRemainingTimeInMillis'>
): Promise<SQSBatchResponse> {
  if ('Records' in event) {
    return withBadgeLockDeadline(
      context?.getRemainingTimeInMillis() ?? 60_000,
      () => sqsHandler(event)
    );
  }
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
