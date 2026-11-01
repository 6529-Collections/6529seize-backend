import type { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import { refreshProfileBadges } from './badge-refresh';
import { sendE2eeWakes } from './e2ee-wake';
import { handler } from './index';

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
jest.mock('./e2ee-wake', () => ({
  ...jest.requireActual('./e2ee-wake'),
  sendE2eeWakes: jest.fn()
}));

const context = {
  getRemainingTimeInMillis: () => 60_000,
  functionName: 'pushNotificationsHandler'
} as unknown as Context;

function event(...bodies: string[]): SQSEvent {
  return {
    Records: bodies.map(
      (body, index) => ({ messageId: String(index), body }) as SQSRecord
    )
  };
}

const wake = (profileIds: string[], reason: string) =>
  JSON.stringify({ type: 'e2ee_wake', profile_ids: profileIds, reason });

beforeEach(() => {
  jest.mocked(refreshProfileBadges).mockReset().mockResolvedValue([]);
  jest.mocked(sendE2eeWakes).mockReset().mockResolvedValue(undefined);
});

it('sends E2EE wakes in one call next to the other push work', async () => {
  const result = await handler(
    event(
      wake(['a', 'b'], 'message'),
      JSON.stringify({ type: 'badge_refresh', profile_id: 'c' }),
      wake(['d'], 'added')
    ),
    context,
    jest.fn()
  );

  expect(result).toEqual({ batchItemFailures: [] });
  expect(sendE2eeWakes).toHaveBeenCalledTimes(1);
  expect(sendE2eeWakes).toHaveBeenCalledWith([
    { profileIds: ['a', 'b'], reason: 'message' },
    { profileIds: ['d'], reason: 'added' }
  ]);
  expect(refreshProfileBadges).toHaveBeenCalledWith(['c']);
});

it('retries only the wake records when sending them fails', async () => {
  jest.mocked(sendE2eeWakes).mockRejectedValue(new Error('lookup failed'));

  const result = await handler(
    event(
      JSON.stringify({ type: 'badge_refresh', profile_id: 'c' }),
      wake(['a'], 'message')
    ),
    context,
    jest.fn()
  );

  expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '1' }] });
});

it('still reports malformed records as failures', async () => {
  const result = await handler(
    event('not json', wake(['a'], 'message')),
    context,
    jest.fn()
  );

  expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '0' }] });
  expect(sendE2eeWakes).toHaveBeenCalledWith([
    { profileIds: ['a'], reason: 'message' }
  ]);
});
