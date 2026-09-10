import {
  sendIdentityPushGroups,
  type IdentityPushNotificationMessage
} from './identity-push-delivery';
import { getDeviceBadgeState, withDeviceBadgeLock } from './device-badge';
import { sendMessages } from './sendPushNotifications';

jest.mock('./device-badge', () => ({
  deviceBadgeKey: (device: { token: string }) => device.token,
  getDeviceBadgeState: jest.fn(),
  withDeviceBadgeLock: jest.fn(
    async (_device: unknown, action: () => Promise<unknown>) => action()
  )
}));
jest.mock('./sendPushNotifications', () => ({ sendMessages: jest.fn() }));

const results = jest.fn().mockResolvedValue([]);
function message(
  id: number,
  profile: string,
  platform = 'ios'
): IdentityPushNotificationMessage {
  return {
    identityId: profile,
    device: {
      device_id: 'phone',
      token: 'token',
      platform,
      profile_id: profile
    },
    input: {
      title: 'Hello',
      body: 'World',
      token: 'token',
      notification_id: id,
      extra_data: { target_profile_id: profile }
    }
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(getDeviceBadgeState)
    .mockReset()
    .mockResolvedValue({ count: 1, profileIds: new Set(['a', 'b']) });
  jest.mocked(sendMessages).mockReset().mockResolvedValue([]);
});

it('uses the same device lock and a fresh aggregate for ordinary iOS alerts', async () => {
  const messages = [message(1, 'a'), message(2, 'b')];
  expect(await sendIdentityPushGroups(messages, results)).toEqual([]);
  expect(withDeviceBadgeLock).toHaveBeenCalledTimes(1);
  expect(getDeviceBadgeState).toHaveBeenCalledTimes(1);
  expect(sendMessages).toHaveBeenCalledWith(
    messages.map((item) => ({ ...item.input, badge: 1 }))
  );
  expect(jest.mocked(sendMessages).mock.invocationCallOrder[0]).toBeGreaterThan(
    jest.mocked(getDeviceBadgeState).mock.invocationCallOrder[0]
  );
});

it('retries ordinary pushes if the aggregate is unavailable rather than sending badge 1 or zero', async () => {
  jest
    .mocked(getDeviceBadgeState)
    .mockRejectedValue(new Error('profile count unavailable'));
  expect(await sendIdentityPushGroups([message(1, 'a')], results)).toEqual([1]);
  expect(sendMessages).not.toHaveBeenCalled();
});

it('does not send to a profile removed since the alert was built', async () => {
  jest
    .mocked(getDeviceBadgeState)
    .mockResolvedValue({ count: 1, profileIds: new Set(['b']) });
  await sendIdentityPushGroups([message(1, 'a'), message(2, 'b')], results);
  expect(sendMessages).toHaveBeenCalledWith([
    expect.objectContaining({ notification_id: 2, badge: 1 })
  ]);
});

it('leaves Android alerts unchanged and independent of badge coordination', async () => {
  const android = message(1, 'a', 'android');
  expect(await sendIdentityPushGroups([android], results)).toEqual([]);
  expect(sendMessages).toHaveBeenCalledWith([android.input]);
  expect(withDeviceBadgeLock).not.toHaveBeenCalled();
  expect(getDeviceBadgeState).not.toHaveBeenCalled();
});

it('coordinates noncanonical iOS platform casing', async () => {
  await sendIdentityPushGroups([message(1, 'a', ' iOS ')], results);
  expect(withDeviceBadgeLock).toHaveBeenCalledTimes(1);
  expect(sendMessages).toHaveBeenCalledWith([
    expect.objectContaining({ badge: 1 })
  ]);
});

it.each(['', 'unknown', 'web'])(
  'preserves the badge for unknown platform %s',
  async (platform) => {
    await sendIdentityPushGroups([message(1, 'a', platform)], results);
    expect(sendMessages).toHaveBeenCalledWith([
      expect.objectContaining({ omitBadge: true })
    ]);
    expect(withDeviceBadgeLock).not.toHaveBeenCalled();
  }
);
