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
const get = jest.fn(async (key: string) => values.get(key) ?? null);
const mGet = jest.fn(async () => {
  throw new Error("CROSSSLOT Keys in request don't hash to the same slot");
});
let available = true;
jest.mock('@/redis', () => ({
  getRedisClient: () =>
    available
      ? {
          get,
          mGet,
          set
        }
      : null
}));
const originalProject = process.env.FIREBASE_PROJECT_ID;
afterEach(() => {
  if (originalProject === undefined) delete process.env.FIREBASE_PROJECT_ID;
  else process.env.FIREBASE_PROJECT_ID = originalProject;
});
const device = { device_id: 'phone', token: 'private-token' };
beforeEach(() => {
  process.env.FIREBASE_PROJECT_ID = 'test-project';
  values.clear();
  set.mockClear();
  get
    .mockReset()
    .mockImplementation(async (key: string) => values.get(key) ?? null);
  mGet.mockClear();
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
  await expect(quarantinePushTarget(device)).rejects.toThrow(
    'Redis operation failed'
  );
  await expect(deliveredPushIds('phone', [1])).rejects.toThrow(
    'Redis operation failed'
  );
  await expect(recordDeliveredPush('phone', 1)).rejects.toThrow(
    'Redis operation failed'
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

it.each([undefined, '', '   '])(
  'fails closed without a project scope (%s)',
  async (scope) => {
    if (scope === undefined) delete process.env.FIREBASE_PROJECT_ID;
    else process.env.FIREBASE_PROJECT_ID = scope;
    await expect(isPushTargetQuarantined(device)).rejects.toThrow(
      'requires FIREBASE_PROJECT_ID'
    );
    await expect(quarantinePushTarget(device)).rejects.toThrow(
      'requires FIREBASE_PROJECT_ID'
    );
    await expect(deliveredPushIds('phone', [1])).rejects.toThrow(
      'requires FIREBASE_PROJECT_ID'
    );
    await expect(recordDeliveredPush('phone', 1)).rejects.toThrow(
      'requires FIREBASE_PROJECT_ID'
    );
    expect(set).not.toHaveBeenCalled();
  }
);

it('keeps quarantine and delivery receipts isolated across Firebase projects', async () => {
  await quarantinePushTarget(device);
  await recordDeliveredPush('phone', 1);
  process.env.FIREBASE_PROJECT_ID = 'other-project';
  expect(await isPushTargetQuarantined(device)).toBe(false);
  expect(await deliveredPushIds('phone', [1])).toEqual(new Set());
});

it('reads receipts across notifications for one device without a cross-slot command', async () => {
  await recordDeliveredPush('phone', 8330);
  expect(await deliveredPushIds('phone', [8330, 8331])).toEqual(
    new Set([8330])
  );
  await recordDeliveredPush('phone', 8331);
  expect(await deliveredPushIds('phone', [8330, 8331])).toEqual(
    new Set([8330, 8331])
  );
  expect(mGet).not.toHaveBeenCalled();
});

it('fails closed when any individual receipt read fails, without retaining Redis data', async () => {
  get.mockRejectedValueOnce(new Error('PRIVATE_REDIS_KEY_TOKEN'));
  await expect(deliveredPushIds('phone', [8330, 8331])).rejects.toMatchObject({
    code: 'push/redis-operation-failed',
    message: 'Push delivery state Redis operation failed'
  });
});
