import { publishPushOutbox } from './publish-outbox';
import { pushNotificationOutboxDb } from '@/notifications/push-notification-outbox.db';
import {
  isActivated,
  sendBatchMessagesToSQS
} from '@/api/push-notifications/push-notifications.service';
import { Logger } from '@/logging';
jest.mock('@/notifications/push-notification-outbox.db', () => ({
  pushNotificationOutboxDb: {
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
  jest.mocked(isActivated).mockReturnValue(true);
  jest.mocked(pushNotificationOutboxDb.oldestPendingAt).mockResolvedValue(null);
  jest.mocked(pushNotificationOutboxDb.publishBatch).mockResolvedValue(0);
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
