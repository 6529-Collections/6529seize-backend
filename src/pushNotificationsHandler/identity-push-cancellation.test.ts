jest.mock('@/websocket-outbox/notification-handoff', () => ({
  retainQueuedNotificationInvalidations: jest.fn().mockResolvedValue(undefined)
}));
import { sendIdentityNotificationsBatch } from './identityPushNotifications';
import { getDataSource } from '@/db';
import { pushNotificationCancellationsDb } from '@/notifications/push-notification-cancellations.db';
import { identityMutesDb } from '@/api/identity-mutes/identity-mutes.db';
import { sendIdentityPushGroups } from './identity-push-delivery';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { competitionAnonymityService } from '@/competitions/competition-anonymity';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';

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

it('preloads each anonymous entry once for a batch of many recipients', async () => {
  const notifications = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    identity_id: `recipient-${index}`,
    additional_identity_id: 'author',
    cause: IdentityNotificationCause.IDENTITY_MENTIONED,
    related_drop_id: 'entry',
    read_at: null
  }));
  jest.mocked(getDataSource).mockReturnValue({
    getRepository: () => ({
      find: async () => notifications,
      findBy: async () => []
    })
  } as unknown as ReturnType<typeof getDataSource>);
  jest
    .mocked(identityMutesDb.filterMutedNotificationRows)
    .mockImplementation(async (rows) => rows);
  jest
    .mocked(contentModerationDb.filterBlockedNotificationRows)
    .mockImplementation(async (rows) => rows);
  jest
    .mocked(contentModerationDb.filterUnavailableDropNotificationRows)
    .mockImplementation(async (rows) => rows);
  const policy = jest
    .spyOn(competitionAnonymityService, 'hiddenDropIds')
    .mockResolvedValue(new Set(['entry']));
  try {
    expect(
      await sendIdentityNotificationsBatch(notifications.map(({ id }) => id))
    ).toEqual([]);
    expect(policy).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledWith(['entry'], {}, { includeOwner: true });
  } finally {
    policy.mockRestore();
  }
});
