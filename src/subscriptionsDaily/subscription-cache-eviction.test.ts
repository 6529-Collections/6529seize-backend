import { createClient } from 'redis';
import {
  evictSubscriptionCacheBatch,
  isSubscriptionCacheKey
} from './subscription-cache-eviction';

jest.mock('redis', () => ({ createClient: jest.fn() }));
const prefix = '__SEIZE_CACHE_test__';
const client = {
  isOpen: true,
  on: jest.fn(),
  connect: jest.fn(),
  sendCommand: jest.fn(),
  del: jest.fn(),
  disconnect: jest.fn()
};
const originalEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env.REDIS_URL = 'localhost';
  process.env.NODE_ENV = 'test';
  process.env.FORCE_AVOID_REDIS = 'false';
  client.isOpen = true;
  client.connect.mockReset().mockResolvedValue(undefined);
  client.sendCommand.mockReset().mockResolvedValue(['0', []]);
  client.del.mockReset().mockResolvedValue(1);
  client.disconnect.mockReset().mockImplementation(async () => {
    client.isOpen = false;
  });
  jest
    .mocked(createClient)
    .mockReturnValue(client as unknown as ReturnType<typeof createClient>);
});
afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

it('matches global and affected subscription routes including query variants, preserving other wallets', () => {
  const affected = new Set(['auto']);
  for (const path of [
    '/api/subscriptions/upcoming-memes-counts',
    '/api/subscriptions/memes/558/count?x=1',
    '/api/subscriptions/consolidation/details/auto?x=1',
    '/api/subscriptions/consolidation/upcoming-memes/auto',
    '/api/subscriptions/consolidation/upcoming-memes/558/auto?x=1'
  ])
    expect(isSubscriptionCacheKey(prefix + path, prefix, affected)).toBe(true);
  for (const path of [
    '/api/subscriptions/consolidation/details/other',
    '/api/profiles/auto',
    '/api/subscriptions/memes/558'
  ])
    expect(isSubscriptionCacheKey(prefix + path, prefix, affected)).toBe(false);
  expect(
    isSubscriptionCacheKey(
      'other-environment/api/subscriptions/upcoming-memes-counts',
      prefix,
      affected
    )
  ).toBe(false);
});

it('scans once per page for hundreds of wallets and preserves unsigned 64-bit cursors exactly', async () => {
  const keys = Array.from(
    { length: 45 },
    (_, i) => `${prefix}/api/subscriptions/consolidation/details/wallet-${i}`
  );
  client.sendCommand
    .mockResolvedValueOnce(['18446744073709551610', keys])
    .mockResolvedValueOnce([
      '0',
      [`${prefix}/api/subscriptions/consolidation/details/unrelated`]
    ]);
  const result = await evictSubscriptionCacheBatch(
    Array.from({ length: 800 }, (_, i) => `wallet-${i}`)
  );
  expect(client.sendCommand).toHaveBeenCalledTimes(2);
  expect(client.sendCommand.mock.calls[1][0][1]).toBe('18446744073709551610');
  expect(client.del.mock.calls).toEqual(keys.map((key) => [key]));
  expect(result).toEqual(
    expect.objectContaining({ scanned: 46, deleted: 45, complete: true })
  );
  expect(client.disconnect).toHaveBeenCalledTimes(1);
});

it('limits concurrent single-key deletes to twenty', async () => {
  let running = 0;
  let maximum = 0;
  client.sendCommand.mockResolvedValue([
    '0',
    Array.from(
      { length: 80 },
      (_, i) => `${prefix}/api/subscriptions/memes/${i}/count`
    )
  ]);
  client.del.mockImplementation(async () => {
    running++;
    maximum = Math.max(maximum, running);
    await Promise.resolve();
    running--;
    return 1;
  });
  await evictSubscriptionCacheBatch(['auto']);
  expect(maximum).toBe(20);
});

it('closes at the deadline and stops commands, restoring real timers before shared DB cleanup', async () => {
  jest.useFakeTimers();
  try {
    let rejectScan: (error: Error) => void = () => {};
    client.sendCommand.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectScan = reject;
        })
    );
    client.disconnect.mockImplementation(async () => {
      client.isOpen = false;
      rejectScan(new Error('connection closed'));
    });
    const assertion = expect(
      evictSubscriptionCacheBatch(['auto'])
    ).rejects.toMatchObject({ failure: { name: 'TimeoutError' }, cursor: '0' });
    await jest.advanceTimersByTimeAsync(1500);
    await assertion;
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(client.sendCommand).toHaveBeenCalledTimes(1);
    expect(client.del).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

it('returns a checkpoint at the deadline after a completed page and resumes from it', async () => {
  jest.useFakeTimers();
  try {
    let rejectScan: (error: Error) => void = () => {};
    client.sendCommand
      .mockResolvedValueOnce([
        '42',
        [`${prefix}/api/subscriptions/upcoming-memes-counts`]
      ])
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectScan = reject;
          })
      );
    client.disconnect.mockImplementation(async () => {
      client.isOpen = false;
      rejectScan(new Error('connection closed'));
    });
    const attempt = evictSubscriptionCacheBatch(['auto']);
    await jest.advanceTimersByTimeAsync(1500);
    expect(await attempt).toEqual(
      expect.objectContaining({ complete: false, cursor: '42', deleted: 1 })
    );
    client.isOpen = true;
    client.sendCommand.mockResolvedValue(['0', []]);
    await evictSubscriptionCacheBatch(['auto'], '42');
    expect(client.sendCommand.mock.calls[2][0][1]).toBe('42');
  } finally {
    jest.useRealTimers();
  }
});

it('replays a partially deleted page rather than skipping its remaining keys', async () => {
  client.sendCommand.mockResolvedValue([
    '84',
    [`${prefix}/api/subscriptions/upcoming-memes-counts`]
  ]);
  client.del.mockRejectedValue(new Error('Redis failed'));
  await expect(
    evictSubscriptionCacheBatch(['auto'], '42')
  ).rejects.toMatchObject({ cursor: '42' });
  expect(client.disconnect).toHaveBeenCalledTimes(1);
});

it('does not treat missing configuration as successful eviction, but reports explicit disablement', async () => {
  delete process.env.REDIS_URL;
  await expect(evictSubscriptionCacheBatch(['auto'])).rejects.toThrow(
    'REDIS_URL is missing'
  );
  process.env.FORCE_AVOID_REDIS = 'true';
  expect(await evictSubscriptionCacheBatch(['auto'])).toEqual(
    expect.objectContaining({ skipped: true })
  );
});
