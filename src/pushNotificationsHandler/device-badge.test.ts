import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { getDeviceBadgeState, withDeviceBadgeLock } from './device-badge';
import { DbPoolName } from '@/db-query.options';
import { PushNotificationDevice } from '@/entities/IPushNotification';
import { DEFAULT_PUSH_NOTIFICATION_SETTINGS } from '@/entities/IPushNotificationSettings';

const findDevices = jest.fn();
const findSettings = jest.fn();
const countUnread = jest.fn();
const redisSet = jest.fn();
const redisEval = jest.fn();
let redisAvailable = true;
jest.mock('@/db', () => ({
  getDataSource: () => ({
    getRepository: (entity: unknown) =>
      entity === PushNotificationDevice
        ? { findBy: findDevices }
        : { findOneBy: findSettings }
  })
}));
jest.mock('@/notifications/identity-notifications.db', () => ({
  identityNotificationsDb: {
    countUnreadNotificationsForIdentity: (...args: unknown[]) =>
      countUnread(...args)
  }
}));
jest.mock('@/api/community-members/user-groups.service', () => ({
  userGroupsService: {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(['group'])
  }
}));
jest.mock('@/redis', () => ({
  getRedisClient: () =>
    redisAvailable ? { set: redisSet, eval: redisEval } : null
}));

const device = { device_id: 'phone', token: 'token' };
beforeEach(() => {
  jest.clearAllMocks();
  findDevices.mockResolvedValue([
    { profile_id: 'a', token: 'token' },
    { profile_id: 'b', token: 'token' }
  ]);
  findSettings.mockResolvedValue(null);
  countUnread.mockReset().mockResolvedValue(1);
  redisAvailable = true;
  redisSet.mockResolvedValue('OK');
  redisEval.mockResolvedValue(1);
});

it('refreshes 2 → 1 → 0 from profile counts, including zero on the final read', async () => {
  expect((await getDeviceBadgeState(device)).count).toBe(2);
  countUnread.mockImplementation(async (profile: string) =>
    profile === 'a' ? 0 : 1
  );
  expect((await getDeviceBadgeState(device)).count).toBe(1);
  countUnread.mockResolvedValue(0);
  expect((await getDeviceBadgeState(device)).count).toBe(0);
  expect(countUnread).toHaveBeenCalledWith(
    'b',
    ['group'],
    undefined,
    expect.objectContaining({ forcePool: DbPoolName.WRITE })
  );
  expect(findDevices).toHaveBeenCalledWith({ device_id: 'phone' });
});

it('deduplicates profiles and supports single-profile devices', async () => {
  findDevices.mockResolvedValue([
    { profile_id: 'a', token: 'token' },
    { profile_id: 'a', token: 'token' }
  ]);
  expect((await getDeviceBadgeState(device)).count).toBe(1);
  expect(countUnread).toHaveBeenCalledTimes(1);
  countUnread.mockResolvedValue(0);
  expect((await getDeviceBadgeState(device)).count).toBe(0);
});

it('fails closed if any profile refresh fails', async () => {
  countUnread
    .mockResolvedValueOnce(0)
    .mockRejectedValueOnce(new Error('offline'));
  await expect(getDeviceBadgeState(device)).rejects.toThrow(
    'Unable to refresh all'
  );
});

it('preserves device notification preferences', async () => {
  const disabled = Object.fromEntries(
    Object.keys(DEFAULT_PUSH_NOTIFICATION_SETTINGS).map((key) => [key, false])
  );
  findSettings.mockResolvedValue(disabled);
  await getDeviceBadgeState(device);
  const options = countUnread.mock.calls[0][3];
  expect(options.enabledCauses).not.toContain(
    IdentityNotificationCause.IDENTITY_MENTIONED
  );
  expect(options.enabledCauses).toContain(IdentityNotificationCause.ALL_DROPS);
});

it('skips counts for a device whose registrations were removed', async () => {
  findDevices.mockResolvedValue([]);
  expect((await getDeviceBadgeState(device)).profileIds.size).toBe(0);
  expect(countUnread).not.toHaveBeenCalled();
});

it('releases the owned lock after both success and failure', async () => {
  await expect(withDeviceBadgeLock(device, async () => 3)).resolves.toBe(3);
  await expect(
    withDeviceBadgeLock(device, async () => {
      throw new Error('count failed');
    })
  ).rejects.toThrow('count failed');
  expect(redisSet).toHaveBeenCalledWith(
    expect.stringMatching(/^push-badge-lock:/),
    expect.any(String),
    { NX: true, EX: 120 }
  );
  expect(redisEval).toHaveBeenCalledTimes(2);
  expect(redisEval.mock.calls[0][1].arguments).toEqual([
    redisSet.mock.calls[0][1]
  ]);
});

it.each(['busy', 'unavailable'])(
  'never sends without coordination: %s',
  async (reason) => {
    if (reason === 'busy') redisSet.mockResolvedValue(null);
    else redisAvailable = false;
    const action = jest.fn();
    await expect(withDeviceBadgeLock(device, action)).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
    expect(redisEval).not.toHaveBeenCalled();
  }
);

it('counts all connected profiles during partial token rotation', async () => {
  findDevices.mockResolvedValue([
    { profile_id: 'a', token: 'new-token' },
    { profile_id: 'b', token: 'token' }
  ]);
  expect(await getDeviceBadgeState(device)).toEqual({
    count: 2,
    profileIds: new Set(['b'])
  });
  expect(await getDeviceBadgeState({ ...device, token: 'new-token' })).toEqual({
    count: 2,
    profileIds: new Set(['a'])
  });
});

it('uses one lock across tokens belonging to the same device', async () => {
  await withDeviceBadgeLock(device, async () => undefined);
  await withDeviceBadgeLock(
    { ...device, token: 'rotated' },
    async () => undefined
  );
  expect(redisSet.mock.calls[0][0]).toBe(redisSet.mock.calls[1][0]);
});

it('preserves action success and failure when releasing the lock fails', async () => {
  redisEval.mockRejectedValue(new Error('Redis unavailable'));
  await expect(withDeviceBadgeLock(device, async () => 3)).resolves.toBe(3);
  const failure = new Error('send failed');
  await expect(
    withDeviceBadgeLock(device, async () => {
      throw failure;
    })
  ).rejects.toBe(failure);
});

it('counts remaining profiles when logout removed the latest-token registration', async () => {
  findDevices.mockResolvedValue([{ profile_id: 'b', token: 'older-token' }]);
  expect(await getDeviceBadgeState(device)).toEqual({
    count: 1,
    profileIds: new Set()
  });
});
