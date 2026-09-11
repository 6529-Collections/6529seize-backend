import {
  refreshProfileBadges,
  refreshInstallationBadge
} from './badge-refresh';
import { getDeviceBadgeState, withDeviceBadgeLock } from './device-badge';
import { sendBadgeUpdate } from './sendPushNotifications';

const findDevices = jest.fn();
const deleteDevice = jest.fn();
const findInstallation = jest.fn();
const updateInstallation = jest.fn();
jest.mock('@/db', () => ({
  getDataSource: () => ({
    getRepository: () => ({
      findBy: findDevices,
      delete: deleteDevice,
      findOneBy: findInstallation,
      update: updateInstallation
    })
  })
}));
jest.mock('./sendPushNotifications', () => ({ sendBadgeUpdate: jest.fn() }));
jest.mock('./device-badge', () => ({
  deviceBadgeKey: (device: { token: string }) => device.token,
  getDeviceBadgeState: jest.fn(),
  withDeviceBadgeLock: jest.fn(
    async (_device: unknown, action: () => Promise<unknown>) => action()
  )
}));

const phone = { device_id: 'phone', token: 'token', platform: 'ios' };
beforeEach(() => {
  jest.clearAllMocks();
  findInstallation.mockResolvedValue(phone);
  findDevices.mockResolvedValue([
    { ...phone, profile_id: 'a' },
    { ...phone, profile_id: 'b' }
  ]);
  jest
    .mocked(getDeviceBadgeState)
    .mockReset()
    .mockResolvedValue({ count: 1, profileIds: new Set(['a', 'b']) });
  jest.mocked(sendBadgeUpdate).mockReset().mockResolvedValue(undefined);
  deleteDevice.mockResolvedValue({});
});

it('coalesces shared-device reads into one iOS update', async () => {
  expect(await refreshProfileBadges(['a', 'a', 'b'])).toEqual([]);
  expect(findDevices).toHaveBeenCalledWith(
    expect.objectContaining({ profile_id: expect.anything() })
  );
  expect(withDeviceBadgeLock).toHaveBeenCalledTimes(1);
  expect(sendBadgeUpdate).toHaveBeenCalledTimes(1);
  expect(sendBadgeUpdate).toHaveBeenCalledWith('token', 1);
});

it('sends zero for a single-profile device after its final read', async () => {
  findDevices.mockResolvedValue([{ ...phone, profile_id: 'a' }]);
  jest
    .mocked(getDeviceBadgeState)
    .mockResolvedValue({ count: 0, profileIds: new Set(['a']) });
  await refreshProfileBadges(['a']);
  expect(sendBadgeUpdate).toHaveBeenCalledWith('token', 0);
});

it('does not clear badges when aggregate refresh fails and retries affected profiles', async () => {
  jest
    .mocked(getDeviceBadgeState)
    .mockRejectedValue(new Error('count unavailable'));
  expect(await refreshProfileBadges(['a', 'b'])).toEqual(['a', 'b']);
  expect(sendBadgeUpdate).not.toHaveBeenCalled();
});

it('recalculates on retry instead of replaying the failed count', async () => {
  jest
    .mocked(sendBadgeUpdate)
    .mockRejectedValueOnce(new Error('FCM unavailable'));
  expect(await refreshProfileBadges(['a'])).toContain('a');
  jest
    .mocked(getDeviceBadgeState)
    .mockResolvedValue({ count: 3, profileIds: new Set(['a', 'b']) });
  expect(await refreshProfileBadges(['a'])).toEqual([]);
  expect(sendBadgeUpdate).toHaveBeenLastCalledWith('token', 3);
});

it('skips disconnected or rotated registrations', async () => {
  jest
    .mocked(getDeviceBadgeState)
    .mockResolvedValue({ count: 0, profileIds: new Set() });
  expect(await refreshProfileBadges(['a'])).toEqual([]);
  expect(sendBadgeUpdate).not.toHaveBeenCalled();
});

it('cleans up only the exact unregistered token', async () => {
  jest
    .mocked(sendBadgeUpdate)
    .mockRejectedValue({ code: 'messaging/registration-token-not-registered' });
  expect(await refreshProfileBadges(['a'])).toEqual([]);
  expect(deleteDevice).toHaveBeenCalledWith({
    device_id: 'phone',
    token: 'token'
  });
});

it('does nothing for profiles with no iOS registrations', async () => {
  findDevices.mockResolvedValue([]);
  expect(await refreshProfileBadges(['android-only'])).toEqual([]);
  expect(sendBadgeUpdate).not.toHaveBeenCalled();
});

it('recognizes legacy iOS casing and skips Android or unknown platforms', async () => {
  findDevices.mockResolvedValue([
    { ...phone, profile_id: 'a', platform: ' iOS ' },
    { ...phone, token: 'android', profile_id: 'b', platform: 'android' },
    { ...phone, token: 'unknown', profile_id: 'b', platform: null }
  ]);
  expect(await refreshProfileBadges(['a', 'b'])).toEqual([]);
  expect(sendBadgeUpdate).toHaveBeenCalledTimes(1);
  expect(sendBadgeUpdate).toHaveBeenCalledWith('token', 1);
});

describe('installation logout badge refresh', () => {
  it('sends the remaining profile count after a single logout', async () => {
    await refreshInstallationBadge('phone');
    expect(sendBadgeUpdate).toHaveBeenCalledWith('token', 1);
  });
  it('can send zero after the final registration row is removed', async () => {
    jest
      .mocked(getDeviceBadgeState)
      .mockResolvedValue({ count: 0, profileIds: new Set() });
    await refreshInstallationBadge('phone');
    expect(sendBadgeUpdate).toHaveBeenCalledWith('token', 0);
  });
  it('propagates count failures without falsely clearing the badge', async () => {
    jest
      .mocked(getDeviceBadgeState)
      .mockRejectedValue(new Error('database unavailable'));
    await expect(refreshInstallationBadge('phone')).rejects.toThrow(
      'database unavailable'
    );
    expect(sendBadgeUpdate).not.toHaveBeenCalled();
  });
  it('skips numeric badge updates for Android', async () => {
    findInstallation.mockResolvedValue({ ...phone, platform: 'android' });
    await refreshInstallationBadge('phone');
    expect(getDeviceBadgeState).not.toHaveBeenCalled();
    expect(sendBadgeUpdate).not.toHaveBeenCalled();
  });
  it('retires an invalid token without touching a concurrent replacement', async () => {
    jest.mocked(sendBadgeUpdate).mockRejectedValue({
      code: 'messaging/registration-token-not-registered'
    });
    await refreshInstallationBadge('phone');
    expect(updateInstallation).toHaveBeenCalledWith(
      { device_id: 'phone', token: 'token' },
      { token: null }
    );
  });
});
