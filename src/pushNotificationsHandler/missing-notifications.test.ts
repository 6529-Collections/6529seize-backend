import { handleMissingNotifications } from './missing-notifications';
import { pushNotificationCancellationsDb } from '@/notifications/push-notification-cancellations.db';
import { Logger } from '@/logging';

jest.mock('@/notifications/push-notification-cancellations.db', () => ({
  pushNotificationCancellationsDb: { findCancelledIds: jest.fn() }
}));
jest.mock('@/logging', () => {
  const logger = { info: jest.fn(), error: jest.fn() };
  return { Logger: { get: () => logger } };
});
const logger = Logger.get('test');
beforeEach(() => jest.clearAllMocks());

it('acknowledges confirmed cancellations with only an informational log', async () => {
  jest
    .mocked(pushNotificationCancellationsDb.findCancelledIds)
    .mockResolvedValue(new Set([1]));
  expect(await handleMissingNotifications([1])).toEqual([]);
  expect(logger.info).toHaveBeenCalledWith(
    'Skipping cancelled notification: 1'
  );
  expect(logger.error).not.toHaveBeenCalled();
});
it('retries and reports unexplained missing IDs in a mixed batch', async () => {
  jest
    .mocked(pushNotificationCancellationsDb.findCancelledIds)
    .mockResolvedValue(new Set([1]));
  expect(await handleMissingNotifications([1, 2])).toEqual([2]);
  expect(logger.error).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith('Notification not found: 2');
});
it('retries all missing IDs on lookup failure and reports the operational error', async () => {
  jest
    .mocked(pushNotificationCancellationsDb.findCancelledIds)
    .mockRejectedValue(new Error('database unavailable'));
  expect(await handleMissingNotifications([1, 2])).toEqual([1, 2]);
  expect(logger.error).toHaveBeenCalledTimes(1);
  expect(logger.info).not.toHaveBeenCalled();
});
it('does not query cancellations when every notification exists', async () => {
  expect(await handleMissingNotifications([])).toEqual([]);
  expect(
    pushNotificationCancellationsDb.findCancelledIds
  ).not.toHaveBeenCalled();
});
