import {
  deliveredPushIds,
  recordDeliveredPush,
  isPushTargetQuarantined,
  isSenderMismatch,
  quarantinePushTarget
} from '@/pushNotificationsHandler/push-delivery-state';

const values = new Map<string, string>();
const set = jest.fn(async (key: string, value: string) => {
  values.set(key, value);
  return 'OK';
});
let available = true;
jest.mock('@/redis', () => ({
  getRedisClient: () =>
    available
      ? {
          get: async (key: string) => values.get(key) ?? null,
          mGet: async (keys: string[]) =>
            keys.map((key) => values.get(key) ?? null),
          set
        }
      : null
}));
const device = { device_id: 'phone', token: 'private-token' };
beforeEach(() => {
  values.clear();
  set.mockClear();
  available = true;
});

it('isolates incompatible tokens and allows rotated tokens without deleting registrations', async () => {
  await quarantinePushTarget(device);
  expect(await isPushTargetQuarantined(device)).toBe(true);
  expect(await isPushTargetQuarantined({ ...device, token: 'rotated' })).toBe(
    false
  );
  expect(await isPushTargetQuarantined({ ...device, device_id: 'other' })).toBe(
    false
  );
  expect(set).toHaveBeenCalledWith(
    expect.not.stringContaining(device.token),
    '1',
    { EX: 86400 }
  );
});

it('keeps successes separate by device and notification for the full retry horizon', async () => {
  await recordDeliveredPush('phone', 1);
  expect(await deliveredPushIds('phone', [1, 2])).toEqual(new Set([1]));
  expect(await deliveredPushIds('other', [1])).toEqual(new Set());
  expect(set).toHaveBeenCalledWith(expect.any(String), '1', { EX: 8 * 86400 });
});

it('does not acknowledge work or send when coordination is unavailable', async () => {
  available = false;
  await expect(quarantinePushTarget(device)).rejects.toThrow('requires Redis');
  await expect(deliveredPushIds('phone', [1])).rejects.toThrow(
    'requires Redis'
  );
  await expect(recordDeliveredPush('phone', 1)).rejects.toThrow(
    'requires Redis'
  );
});

it('classifies only the explicit provider code, never arbitrary message text', () => {
  expect(isSenderMismatch({ code: 'messaging/mismatched-credential' })).toBe(
    true
  );
  expect(isSenderMismatch(new Error('SenderId mismatch'))).toBe(false);
  expect(isSenderMismatch({ code: 'messaging/internal-error' })).toBe(false);
  expect(isSenderMismatch(null)).toBe(false);
});
