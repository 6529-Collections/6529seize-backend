import {
  isActivated,
  sendBatchMessagesToSQS
} from '@/api/push-notifications/push-notifications.service';
import {
  OUTBOX_BATCH_SIZE,
  pushNotificationOutboxDb
} from '@/notifications/push-notification-outbox.db';
import { notificationViewPushDb } from '@/notifications/view/notification-view-push.db';
import { notifyViewMode } from '@/notifications/view/notify-view-flags';
import { Logger } from '@/logging';

const logger = Logger.get('PUSH_NOTIFICATION_OUTBOX');

function publishOldIds(): Promise<number> {
  return pushNotificationOutboxDb.publishBatch((ids) =>
    sendBatchMessagesToSQS(
      ids.map((id) => ({
        Id: `identity-notification-${id}`,
        MessageBody: JSON.stringify({ identity_notification_id: id })
      }))
    )
  );
}

/** The view's queue (NOTIFY_VIEW_MODE `on`), by row key: view ids repeat across people. */
function publishViewKeys(): Promise<number> {
  return notificationViewPushDb.publishBatch((keys) =>
    sendBatchMessagesToSQS(
      keys.map((key, index) => ({
        Id: `view-notification-${index}`,
        MessageBody: JSON.stringify({ view_notification: key })
      }))
    )
  );
}

export async function publishPushOutbox(): Promise<void> {
  if (!isActivated()) return;
  const deadline = Date.now() + 40_000;
  // The view's tables exist from `shadow` on; its queue drains in every mode
  // but `off`, so pushes queued in `on` still go out after a rollback.
  const viewQueue = notifyViewMode() !== 'off';
  const oldest = Math.min(
    ...[
      await pushNotificationOutboxDb.oldestPendingAt(),
      viewQueue ? await notificationViewPushDb.oldestPendingAt() : null
    ].map((at) => at ?? Infinity)
  );
  if (Date.now() - oldest > 5 * 60_000) {
    const error = new Error(
      'Committed push notifications have waited over five minutes for queue publication'
    );
    error.name = 'PushOutbox.BACKLOG';
    logger.error(error.message, error);
  }
  let published = 0;
  let oldIdsDone = false;
  let viewKeysDone = !viewQueue;
  // Alternate the queues so neither waits behind the other's backlog.
  while (Date.now() < deadline) {
    if (!oldIdsDone) {
      const count = await publishOldIds();
      published += count;
      oldIdsDone = count < OUTBOX_BATCH_SIZE;
    }
    if (!viewKeysDone) {
      const count = await publishViewKeys();
      published += count;
      viewKeysDone = count < OUTBOX_BATCH_SIZE;
    }
    if (oldIdsDone && viewKeysDone) {
      logger.info(`Published ${published} committed push notifications`);
      return;
    }
  }
  logger.warn(
    'Push outbox publication reached its time budget; remaining rows will retry next minute'
  );
}
