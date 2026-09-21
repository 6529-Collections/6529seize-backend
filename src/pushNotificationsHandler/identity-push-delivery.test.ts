import {
  isPushTargetQuarantined,
  quarantinePushTarget,
  deliveredPushIds,
  recordDeliveredPush
} from '@/pushNotificationsHandler/push-delivery-state';
jest.mock('@/pushNotificationsHandler/push-delivery-state', () => ({
  ...jest.requireActual('@/pushNotificationsHandler/push-delivery-state'),
  isPushTargetQuarantined: jest.fn().mockResolvedValue(false),
  quarantinePushTarget: jest.fn().mockResolvedValue(undefined),
  deliveredPushIds: jest.fn().mockResolvedValue(new Set()),
  recordDeliveredPush: jest.fn().mockResolvedValue(undefined)
}));
const mockFindRegistrations = jest.fn();
jest.mock('@/db', () => ({
  getDataSource: () => ({
    getRepository: () => ({ findBy: mockFindRegistrations })
  })
}));
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
  jest.mocked(deliveredPushIds).mockReset().mockResolvedValue(new Set());
  jest.mocked(recordDeliveredPush).mockReset().mockResolvedValue(undefined);
  results.mockReset().mockResolvedValue([]);
  jest.mocked(isPushTargetQuarantined).mockReset().mockResolvedValue(false);
  jest.mocked(quarantinePushTarget).mockReset().mockResolvedValue(undefined);
  mockFindRegistrations.mockResolvedValue([
    { profile_id: 'a' },
    { profile_id: 'b' }
  ]);
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

it('coordinates Android alerts with logout without calculating an iOS badge', async () => {
  const android = message(1, 'a', 'android');
  expect(await sendIdentityPushGroups([android], results)).toEqual([]);
  expect(sendMessages).toHaveBeenCalledWith([
    { ...android.input, omitBadge: true }
  ]);
  expect(withDeviceBadgeLock).toHaveBeenCalledTimes(1);
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
    expect(withDeviceBadgeLock).toHaveBeenCalledTimes(1);
  }
);

it('drops an Android recipient removed after the alert was built', async () => {
  mockFindRegistrations.mockResolvedValue([{ profile_id: 'b' }]);
  await sendIdentityPushGroups(
    [message(1, 'a', 'android'), message(2, 'b', 'android')],
    results
  );
  expect(sendMessages).toHaveBeenCalledWith([
    expect.objectContaining({ notification_id: 2, omitBadge: true })
  ]);
});

it('retries only failed targets after another device accepted the same notification', async () => {
  const first = message(50, 'a');
  const second = {
    ...message(50, 'a'),
    device: { ...first.device, device_id: 'second-phone', token: 'other' },
    input: { ...first.input, token: 'other' }
  };
  const delivered = new Map<string, Set<number>>();
  jest
    .mocked(deliveredPushIds)
    .mockImplementation(async (device) => delivered.get(device) ?? new Set());
  jest.mocked(recordDeliveredPush).mockImplementation(async (device, id) => {
    delivered.set(device, new Set([id]));
  });
  jest.mocked(sendMessages).mockImplementation(async (inputs) =>
    inputs.map((input) => ({
      input,
      response:
        input.token === 'token'
          ? { success: true }
          : {
              success: false,
              error: Object.assign(new Error('temporary'), {
                code: 'messaging/internal-error',
                toJSON: () => ({})
              })
            }
    }))
  );
  results.mockImplementation(async (_messages, sends) =>
    sends
      .filter((s: { response: { success: boolean } }) => !s.response.success)
      .map(
        (s: { input: { notification_id: number } }) => s.input.notification_id
      )
  );
  expect(await sendIdentityPushGroups([first, second], results)).toEqual([50]);
  jest.mocked(sendMessages).mockClear();
  jest
    .mocked(sendMessages)
    .mockImplementation(async (inputs) =>
      inputs.map((input) => ({ input, response: { success: true } }))
    );
  expect(await sendIdentityPushGroups([first, second], results)).toEqual([]);
  expect(sendMessages).toHaveBeenCalledTimes(1);
  expect(jest.mocked(sendMessages).mock.calls[0][0][0].token).toBe('other');
});

it('acknowledges sender mismatch only after quarantining the exact target', async () => {
  const item = message(1, 'a');
  jest.mocked(sendMessages).mockResolvedValue([
    {
      input: item.input,
      response: {
        success: false,
        error: Object.assign(new Error('mismatch'), {
          code: 'messaging/mismatched-credential',
          toJSON: () => ({})
        })
      }
    }
  ]);
  expect(await sendIdentityPushGroups([item], results)).toEqual([]);
  expect(quarantinePushTarget).toHaveBeenCalledWith(item.device);
  jest
    .mocked(quarantinePushTarget)
    .mockRejectedValue(new Error('state unavailable'));
  expect(await sendIdentityPushGroups([item], results)).toEqual([1]);
});

it('fails closed before sending when receipt lookup fails', async () => {
  jest
    .mocked(deliveredPushIds)
    .mockRejectedValue(new Error('Redis unavailable'));
  expect(await sendIdentityPushGroups([message(1, 'a')], results)).toEqual([1]);
  expect(sendMessages).not.toHaveBeenCalled();
});

it('skips quarantined targets without deleting profile registrations', async () => {
  jest.mocked(isPushTargetQuarantined).mockResolvedValue(true);
  expect(await sendIdentityPushGroups([message(1, 'a')], results)).toEqual([]);
  expect(sendMessages).not.toHaveBeenCalled();
});

it('retains retry when provider acceptance cannot be recorded', async () => {
  const item = message(1, 'a');
  jest
    .mocked(sendMessages)
    .mockResolvedValue([{ input: item.input, response: { success: true } }]);
  jest
    .mocked(recordDeliveredPush)
    .mockRejectedValue(new Error('Redis write unavailable'));
  expect(await sendIdentityPushGroups([item], results)).toEqual([1]);
  expect(results).not.toHaveBeenCalled();
});

it('serializes token variants belonging to the same device', async () => {
  const first = message(1, 'a');
  const second = {
    ...message(2, 'b'),
    device: { ...first.device, token: 'rotated' },
    input: { ...message(2, 'b').input, token: 'rotated' }
  };
  let active = false;
  jest
    .mocked(withDeviceBadgeLock)
    .mockImplementation(async (_device, action) => {
      expect(active).toBe(false);
      active = true;
      try {
        return await action();
      } finally {
        active = false;
      }
    });
  expect(await sendIdentityPushGroups([first, second], results)).toEqual([]);
  expect(withDeviceBadgeLock).toHaveBeenCalledTimes(2);
});
