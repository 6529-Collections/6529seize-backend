jest.mock('@/redis', () => ({ redisGet: jest.fn(), redisSetJson: jest.fn() }));

import { redisGet, redisSetJson } from '@/redis';
import {
  decodeJoinedWaveCursor,
  encodeJoinedWaveCursor,
  JoinedWaveSnapshotStore
} from './joined-wave-snapshot';

const store = new JoinedWaveSnapshotStore();
const values = new Map<string, unknown>();

beforeEach(() => {
  jest.clearAllMocks();
  values.clear();
  jest.mocked(redisSetJson).mockImplementation(async (key, value) => {
    values.set(key, value);
  });
  jest
    .mocked(redisGet)
    .mockImplementation(async (key) => values.get(key) ?? null);
});

it('persists a snapshot and binds continuation to its profile and page size', async () => {
  const snapshot = await store.create('alice', ['one', 'two', 'three'], 2);
  const cursor = decodeJoinedWaveCursor(encodeJoinedWaveCursor(snapshot, 2));
  expect(await store.read('alice', cursor)).toEqual(snapshot);
  await expect(store.read('bob', cursor)).rejects.toMatchObject({
    code: 'JOINED_WAVE_SNAPSHOT_EXPIRED'
  });
  await expect(store.read('alice', { ...cursor, pageSize: 3 })).rejects.toThrow(
    'Invalid joined wave cursor'
  );
  await expect(store.read('alice', { ...cursor, offset: 4 })).rejects.toThrow(
    'Invalid joined wave cursor'
  );
  await expect(store.read('alice', { ...cursor, offset: 3 })).rejects.toThrow(
    'Invalid joined wave cursor'
  );
});

it('rejects expired snapshots without silently starting a different list', async () => {
  const snapshot = await store.create('alice', ['one', 'two'], 1);
  values.forEach((value, key) =>
    values.set(key, { ...(value as object), expiresAt: 0 })
  );
  await expect(
    store.read(
      'alice',
      decodeJoinedWaveCursor(encodeJoinedWaveCursor(snapshot, 1))
    )
  ).rejects.toMatchObject({ code: 'JOINED_WAVE_SNAPSHOT_EXPIRED' });
});

it('does not issue unusable cursors when cache writes fail open', async () => {
  jest.mocked(redisSetJson).mockResolvedValue(undefined);
  await expect(store.create('alice', ['one', 'two'], 1)).rejects.toMatchObject({
    code: 'JOINED_WAVE_SNAPSHOT_UNAVAILABLE'
  });
});

it('serves a complete first page without requiring snapshot storage', async () => {
  jest.mocked(redisSetJson).mockResolvedValue(undefined);
  const snapshot = await store.create('alice', ['one', 'two'], 2);
  expect(snapshot.waveIds).toEqual(['one', 'two']);
  expect(redisSetJson).not.toHaveBeenCalled();
  expect(redisGet).not.toHaveBeenCalled();
});

it('rejects oversized snapshots without truncating the joined list', async () => {
  await expect(
    store.create('alice', Array<string>(50001).fill('wave'), 20)
  ).rejects.toMatchObject({ code: 'JOINED_WAVE_SNAPSHOT_UNAVAILABLE' });
  expect(redisSetJson).not.toHaveBeenCalled();
});

it('reports throwing storage commands as temporary unavailability', async () => {
  jest
    .mocked(redisSetJson)
    .mockRejectedValueOnce(new Error('Redis unavailable'));
  await expect(store.create('alice', ['one', 'two'], 1)).rejects.toMatchObject({
    code: 'JOINED_WAVE_SNAPSHOT_UNAVAILABLE'
  });
  const snapshot = await store.create('alice', ['one', 'two'], 1);
  jest.mocked(redisGet).mockRejectedValueOnce(new Error('Invalid cached JSON'));
  await expect(
    store.read(
      'alice',
      decodeJoinedWaveCursor(encodeJoinedWaveCursor(snapshot, 1))
    )
  ).rejects.toMatchObject({ code: 'JOINED_WAVE_SNAPSHOT_UNAVAILABLE' });
});

it.each([
  '',
  'abc',
  'v1.foo.1.20',
  'v1.00000000-0000-4000-8000-000000000529.-1.20',
  'v1.00000000-0000-4000-8000-000000000529.1x.20'
])('rejects malformed cursors: %s', (cursor) => {
  expect(() => decodeJoinedWaveCursor(cursor)).toThrow(
    'Invalid joined wave cursor'
  );
});
