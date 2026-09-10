import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import { handler } from './index';
import { refreshProfileBadges } from './badge-refresh';
import { sendIdentityNotificationsBatch } from './identityPushNotifications';

jest.mock('@/secrets', () => ({
  doInDbContext: (action: () => Promise<unknown>) => action()
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (action: unknown) => action
}));
jest.mock('./badge-refresh', () => ({ refreshProfileBadges: jest.fn() }));
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
