import { publishPushOutbox } from './publish-outbox';
import { pushNotificationOutboxDb } from '@/notifications/push-notification-outbox.db';
import { notificationViewPushDb } from '@/notifications/view/notification-view-push.db';
import {
  isActivated,
  sendBatchMessagesToSQS
} from '@/api/push-notifications/push-notifications.service';
import { Logger } from '@/logging';
jest.mock('@/notifications/push-notification-outbox.db', () => ({
  OUTBOX_BATCH_SIZE: 10,
  pushNotificationOutboxDb: {
    oldestPendingAt: jest.fn(),
    publishBatch: jest.fn()
  }
}));
jest.mock('@/notifications/view/notification-view-push.db', () => ({
  notificationViewPushDb: {
    oldestPendingAt: jest.fn(),
    publishBatch: jest.fn()
  }
}));
jest.mock('@/api/push-notifications/push-notifications.service', () => ({
  isActivated: jest.fn(),
  sendBatchMessagesToSQS: jest.fn()
}));
jest.mock('@/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { Logger: { get: () => logger } };
});
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.NOTIFY_VIEW_MODE;
  jest.mocked(isActivated).mockReturnValue(true);
  jest.mocked(pushNotificationOutboxDb.oldestPendingAt).mockResolvedValue(null);
  jest.mocked(pushNotificationOutboxDb.publishBatch).mockResolvedValue(0);
  jest.mocked(notificationViewPushDb.oldestPendingAt).mockResolvedValue(null);
  jest.mocked(notificationViewPushDb.publishBatch).mockResolvedValue(0);
});
afterAll(() => {
  delete process.env.NOTIFY_VIEW_MODE;
});
it('does not consume work while push delivery is disabled', async () => {
  jest.mocked(isActivated).mockReturnValue(false);
  await publishPushOutbox();
  expect(pushNotificationOutboxDb.publishBatch).not.toHaveBeenCalled();
});
it('reports overdue work and still publishes it', async () => {
  jest
    .mocked(pushNotificationOutboxDb.oldestPendingAt)
    .mockResolvedValue(Date.now() - 360_000);
  jest
    .mocked(pushNotificationOutboxDb.publishBatch)
    .mockImplementationOnce(async (send) => {
      await send([12]);
      return 1;
    });
  await publishPushOutbox();
  expect(Logger.get('test').error).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(Error)
  );
  expect(sendBatchMessagesToSQS).toHaveBeenCalledWith([
    {
      Id: 'identity-notification-12',
      MessageBody: '{"identity_notification_id":12}'
    }
  ]);
});
it('surfaces queue publication failure instead of acknowledging the outbox', async () => {
  jest
    .mocked(pushNotificationOutboxDb.publishBatch)
    .mockRejectedValueOnce(new Error('SQS failed'));
  await expect(publishPushOutbox()).rejects.toThrow('SQS failed');
});

describe('the view queue', () => {
  const key = (n: number) => ({
    identity_id: `profile-${n}`,
    source_key: String(n).repeat(64).slice(0, 64)
  });

  it('is left alone while the view is off', async () => {
    await publishPushOutbox();
    expect(notificationViewPushDb.oldestPendingAt).not.toHaveBeenCalled();
    expect(notificationViewPushDb.publishBatch).not.toHaveBeenCalled();
  });

  it('publishes row keys, taking turns with old ids until both are empty', async () => {
    process.env.NOTIFY_VIEW_MODE = 'shadow';
    jest
      .mocked(pushNotificationOutboxDb.publishBatch)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(3);
    jest
      .mocked(notificationViewPushDb.publishBatch)
      .mockImplementationOnce(async (send) => {
        await send([key(1), key(2)]);
        return 10;
      })
      .mockResolvedValueOnce(4);
    await publishPushOutbox();
    expect(pushNotificationOutboxDb.publishBatch).toHaveBeenCalledTimes(3);
    expect(notificationViewPushDb.publishBatch).toHaveBeenCalledTimes(2);
    expect(sendBatchMessagesToSQS).toHaveBeenCalledWith([
      {
        Id: 'view-notification-0',
        MessageBody: JSON.stringify({ view_notification: key(1) })
      },
      {
        Id: 'view-notification-1',
        MessageBody: JSON.stringify({ view_notification: key(2) })
      }
    ]);
  });

  it('counts toward the backlog alert', async () => {
    process.env.NOTIFY_VIEW_MODE = 'on';
    jest
      .mocked(notificationViewPushDb.oldestPendingAt)
      .mockResolvedValue(Date.now() - 360_000);
    await publishPushOutbox();
    expect(Logger.get('test').error).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Error)
    );
  });
});
