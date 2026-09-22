import { sendIdentityNotificationsBatch } from './identityPushNotifications';
import { getDataSource } from '@/db';
import { pushNotificationCancellationsDb } from '@/notifications/push-notification-cancellations.db';
import { identityMutesDb } from '@/api/identity-mutes/identity-mutes.db';
import { sendIdentityPushGroups } from './identity-push-delivery';

jest.mock('@/db', () => ({ getDataSource: jest.fn() }));
jest.mock('@/notifications/push-notification-cancellations.db', () => ({
  pushNotificationCancellationsDb: { findCancelledIds: jest.fn() }
}));
jest.mock('@/api/ws/ws-listeners-notifier', () => ({
  wsListenersNotifier: {
    notifyAboutIdentityNotificationsChanged: jest
      .fn()
      .mockResolvedValue(undefined)
  }
}));
jest.mock('@/api/identity-mutes/identity-mutes.db', () => ({
  identityMutesDb: {
    filterMutedNotificationRows: jest.fn().mockResolvedValue([])
  }
}));
jest.mock('@/content-moderation/content-moderation.db', () => ({
  contentModerationDb: {
    filterBlockedNotificationRows: jest.fn().mockResolvedValue([]),
    filterUnavailableDropNotificationRows: jest.fn().mockResolvedValue([])
  }
}));
jest.mock('./identity-push-delivery', () => ({
  sendIdentityPushGroups: jest.fn()
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(identityMutesDb.filterMutedNotificationRows)
    .mockResolvedValue([]);
  jest.mocked(getDataSource).mockReturnValue({
    getRepository: () => ({ find: async () => [] })
  } as unknown as ReturnType<typeof getDataSource>);
});

it('acknowledges a cancelled queued notification without sending a push', async () => {
  jest
    .mocked(pushNotificationCancellationsDb.findCancelledIds)
    .mockResolvedValue(new Set([1]));
  expect(await sendIdentityNotificationsBatch([1, 1])).toEqual([]);
  expect(pushNotificationCancellationsDb.findCancelledIds).toHaveBeenCalledWith(
    [1]
  );
  expect(sendIdentityPushGroups).not.toHaveBeenCalled();
});

it('returns missing IDs for SQS retry when cancellation lookup fails', async () => {
  jest
    .mocked(pushNotificationCancellationsDb.findCancelledIds)
    .mockRejectedValue(new Error('lookup unavailable'));
  expect(await sendIdentityNotificationsBatch([1, 2])).toEqual([1, 2]);
  expect(sendIdentityPushGroups).not.toHaveBeenCalled();
});

it('does not acknowledge missing IDs when visibility filtering fails first', async () => {
  jest
    .mocked(identityMutesDb.filterMutedNotificationRows)
    .mockRejectedValue(new Error('filter unavailable'));
  expect(await sendIdentityNotificationsBatch([1, 2])).toEqual([1, 2]);
  expect(
    pushNotificationCancellationsDb.findCancelledIds
  ).not.toHaveBeenCalled();
});
