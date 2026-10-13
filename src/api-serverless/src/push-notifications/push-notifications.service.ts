import {
  SendMessageBatchCommand,
  SendMessageBatchCommandInput,
  SQSClient
} from '@aws-sdk/client-sqs';
import { Logger } from '../../../logging';
import { collections } from '@/collections';

const logger = Logger.get('PUSH_NOTIFICATIONS');
const region = process.env.AWS_REGION;

const sqs = new SQSClient({ region });

export function isActivated() {
  return !!process.env.PUSH_NOTIFICATIONS_ACTIVATED;
}

export const sendIdentityPushNotification = async (id: number) => {
  await sendIdentityPushNotifications([id]);
};

export const sendIdentityPushNotifications = async (ids: number[]) =>
  enqueueIdentityPushNotifications(ids, false);

/** Durable producers must retain their receipt until every SQS batch succeeds. */
export const sendIdentityPushNotificationsStrict = async (ids: number[]) =>
  enqueueIdentityPushNotifications(ids, true);

async function enqueueIdentityPushNotifications(
  ids: number[],
  throwOnFailure: boolean
) {
  if (!isActivated()) {
    logger.info('Push notifications are not activated');
    return;
  }
  const uniqueIds = collections.distinct(ids);
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
      if (throwOnFailure) throw error;
      logger.error(
        `[IDENTITY NOTIFICATION IDS ${chunk.join(',')}] Error sending push notification chunk from ${uniqueIds.join(',')}: ${error}`
      );
    }
  }
}

/** Only enqueue here: device discovery, counting and Firebase run in the worker. */
export async function requestDeviceBadgeRefresh(
  profileId: string
): Promise<void> {
  if (!isActivated()) return;
  try {
    await sendBatchMessagesToSQS([
      {
        // This handoff always sends exactly one entry; SQS IDs are unique within a batch only.
        Id: 'badge-refresh',
        MessageBody: JSON.stringify({
          type: 'badge_refresh',
          profile_id: profileId
        })
      }
    ]);
  } catch (error) {
    // The read is already persisted. Do not report a failed read or send a guessed badge.
    logger.error(
      `Failed to enqueue badge refresh for profile ${profileId}: ${error}`
    );
  }
}

/** Logout retries must retry a failed queue handoff, without repeating deletion. */
export async function requestInstallationBadgeRefresh(
  deviceId: string
): Promise<void> {
  if (!isActivated()) return;
  await sendBatchMessagesToSQS([
    {
      Id: 'installation-badge-refresh',
      MessageBody: JSON.stringify({
        type: 'installation_badge_refresh',
        device_id: deviceId
      })
    }
  ]);
}

export type E2eeWakeReason = 'message' | 'added';

/** Profiles per SQS message; keeps bodies far below the SQS size limit. */
const E2EE_WAKE_PROFILES_PER_MESSAGE = 100;

/**
 * Content-free wakes for encrypted messaging (D109). The body names only
 * the recipients and a reason: no sender, group handle or text.
 */
export async function enqueueE2eeWake(
  profileIds: string[],
  reason: E2eeWakeReason
): Promise<void> {
  if (!isActivated()) return;
  const uniqueIds = collections.distinct(profileIds);
  const entries: NonNullable<SendMessageBatchCommandInput['Entries']> = [];
  for (let i = 0; i < uniqueIds.length; i += E2EE_WAKE_PROFILES_PER_MESSAGE) {
    entries.push({
      Id: `e2ee-wake-${entries.length}`,
      MessageBody: JSON.stringify({
        type: 'e2ee_wake',
        profile_ids: uniqueIds.slice(i, i + E2EE_WAKE_PROFILES_PER_MESSAGE),
        reason
      })
    });
  }
  const batches: (typeof entries)[] = [];
  for (let i = 0; i < entries.length; i += 10) {
    batches.push(entries.slice(i, i + 10));
  }
  await Promise.all(batches.map((batch) => sendBatchMessagesToSQS(batch)));
}

export const sendBatchMessagesToSQS = async (
  entries: NonNullable<SendMessageBatchCommandInput['Entries']>
) => {
  const params: SendMessageBatchCommandInput = {
    QueueUrl: `https://sqs.${region}.amazonaws.com/987989283142/firebase-push-notifications`,
    Entries: entries
  };

  const command = new SendMessageBatchCommand(params);
  const response = await sqs.send(command);
  if (response.Failed?.length) {
    throw Object.assign(new Error('Failed to enqueue push notifications'), {
      code: 'PUSH_QUEUE_PARTIAL_FAILURE'
    });
  }
};
