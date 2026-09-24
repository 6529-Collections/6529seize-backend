import {
  isActivated,
  sendBatchMessagesToSQS
} from '@/api/push-notifications/push-notifications.service';
import { pushNotificationOutboxDb } from '@/notifications/push-notification-outbox.db';
import { Logger } from '@/logging';

const logger = Logger.get('PUSH_NOTIFICATION_OUTBOX');

export async function publishPushOutbox(): Promise<void> {
  if (!isActivated()) return;
  const deadline = Date.now() + 40_000;
  const oldest = await pushNotificationOutboxDb.oldestPendingAt();
  if (oldest !== null && Date.now() - oldest > 5 * 60_000) {
    const error = new Error(
      'Committed push notifications have waited over five minutes for queue publication'
    );
    error.name = 'PushOutbox.BACKLOG';
    logger.error(error.message, error);
  }
  let published = 0;
  while (Date.now() < deadline) {
    const count = await pushNotificationOutboxDb.publishBatch((ids) =>
      sendBatchMessagesToSQS(
        ids.map((id) => ({
          Id: `identity-notification-${id}`,
          MessageBody: JSON.stringify({ identity_notification_id: id })
        }))
      )
    );
    published += count;
    if (count < 10) {
      logger.info(`Published ${published} committed push notifications`);
      return;
    }
  }
  logger.warn(
    'Push outbox publication reached its time budget; remaining rows will retry next minute'
  );
}
