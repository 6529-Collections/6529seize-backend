import { Logger } from '@/logging';
import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import { handler } from './index';
import {
  refreshProfileBadges,
  refreshInstallationBadge
} from './badge-refresh';
import { sendIdentityNotificationsBatch } from './identityPushNotifications';

jest.mock('@/secrets', () => ({
  doInDbContext: (action: () => Promise<unknown>) => action()
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (action: unknown) => action
}));
jest.mock('./badge-refresh', () => ({
  refreshProfileBadges: jest.fn(),
  refreshInstallationBadge: jest.fn()
}));
jest.mock('./identityPushNotifications', () => ({
  sendIdentityNotificationsBatch: jest.fn()
}));

function event(...bodies: unknown[]): SQSEvent {
  return {
    Records: bodies.map(
      (body, index) =>
        ({ messageId: String(index), body: JSON.stringify(body) }) as SQSRecord
    )
  };
}

beforeEach(() => {
  jest
    .mocked(refreshInstallationBadge)
    .mockReset()
    .mockResolvedValue(undefined);
  jest.mocked(refreshProfileBadges).mockReset().mockResolvedValue([]);
  jest.mocked(sendIdentityNotificationsBatch).mockReset().mockResolvedValue([]);
});

it('processes mixed normal pushes and refreshes with independent retry results', async () => {
  jest.mocked(refreshProfileBadges).mockResolvedValue(['a']);
  jest.mocked(sendIdentityNotificationsBatch).mockResolvedValue([12]);
  const result = await handler(
    event(
      { type: 'badge_refresh', profile_id: 'a' },
      { identity_notification_id: 12 },
      { type: 'badge_refresh', profile_id: 'b' },
      { type: 'badge_refresh', profile_id: 'a' }
    ),
    {} as Context,
    jest.fn()
  );
  expect(result).toEqual({
    batchItemFailures: [
      { itemIdentifier: '1' },
      { itemIdentifier: '0' },
      { itemIdentifier: '3' }
    ]
  });
  expect(sendIdentityNotificationsBatch).toHaveBeenCalledWith([12]);
  expect(refreshProfileBadges).toHaveBeenCalledWith(['a', 'b', 'a']);
});

it('retries all refresh records if device lookup fails without retrying delivered alerts', async () => {
  jest
    .mocked(refreshProfileBadges)
    .mockRejectedValue(new Error('DB unavailable'));
  expect(
    await handler(
      event(
        { identity_notification_id: 12 },
        { type: 'badge_refresh', profile_id: 'a' }
      ),
      {} as Context,
      jest.fn()
    )
  ).toEqual({ batchItemFailures: [{ itemIdentifier: '1' }] });
});

it('keeps existing notification-only messages compatible', async () => {
  await handler(
    event({ identity_notification_id: 12 }),
    {} as Context,
    jest.fn()
  );
  expect(refreshProfileBadges).not.toHaveBeenCalled();
  expect(sendIdentityNotificationsBatch).toHaveBeenCalledWith([12]);
});

it('routes a message with both fields exclusively to badge refresh', async () => {
  jest.mocked(refreshProfileBadges).mockResolvedValue(['a']);
  expect(
    await handler(
      event({
        type: 'badge_refresh',
        profile_id: 'a',
        identity_notification_id: 12
      }),
      {} as Context,
      jest.fn()
    )
  ).toEqual({ batchItemFailures: [{ itemIdentifier: '0' }] });
  expect(sendIdentityNotificationsBatch).not.toHaveBeenCalled();
});

it('retries only failed installation jobs in a mixed batch', async () => {
  jest
    .mocked(refreshInstallationBadge)
    .mockRejectedValueOnce(new Error('FCM unavailable'))
    .mockResolvedValueOnce(undefined);
  expect(
    await handler(
      event(
        { type: 'installation_badge_refresh', device_id: 'phone-a' },
        { type: 'installation_badge_refresh', device_id: 'phone-b' },
        { identity_notification_id: 12 }
      ),
      {} as Context,
      jest.fn()
    )
  ).toEqual({ batchItemFailures: [{ itemIdentifier: '0' }] });
  expect(refreshInstallationBadge).toHaveBeenCalledWith('phone-b');
  expect(sendIdentityNotificationsBatch).toHaveBeenCalledWith([12]);
});

it.each([7, 8, 10])(
  'reports near-exhaustion only for failed work at receive %i',
  async (count) => {
    const error = jest
      .spyOn(Logger.prototype, 'errorWithCode')
      .mockImplementation(() => undefined);
    try {
      const input = event({ type: 'badge_refresh', profile_id: 'a' });
      input.Records[0].attributes = {
        ApproximateReceiveCount: String(count)
      } as SQSRecord['attributes'];
      jest.mocked(refreshProfileBadges).mockResolvedValue(['a']);
      expect(await handler(input, {} as Context, jest.fn())).toEqual({
        batchItemFailures: [{ itemIdentifier: '0' }]
      });
      expect(error).toHaveBeenCalledTimes(count >= 8 ? 1 : 0);
      error.mockClear();
      jest.mocked(refreshProfileBadges).mockResolvedValue([]);
      await handler(input, {} as Context, jest.fn());
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  }
);
