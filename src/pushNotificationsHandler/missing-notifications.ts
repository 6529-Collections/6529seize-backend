import { Logger } from '@/logging';
import { pushNotificationCancellationsDb } from '@/notifications/push-notification-cancellations.db';
const logger = Logger.get('PUSH_NOTIFICATIONS_HANDLER_IDENTITY');
/** Returns only IDs whose cancellation lookup failed and must be retried. */
export async function handleMissingNotifications(
  ids: number[]
): Promise<number[]> {
  if (!ids.length) return [];
  let cancelled: Set<number>;
  try {
    cancelled = await pushNotificationCancellationsDb.findCancelledIds(ids);
  } catch (error) {
    logger.error(
      'Failed to check notification cancellations; retrying push notifications',
      error
    );
    return ids;
  }
  for (const id of ids) {
    if (cancelled.has(id)) {
      logger.info(`Skipping cancelled notification: ${id}`);
    } else {
      logger.error(`Notification not found: ${id}`);
    }
  }
  return [];
}
