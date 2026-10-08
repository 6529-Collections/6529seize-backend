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
  scan: jest.fn(),
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
  client.scan.mockReset().mockResolvedValue({ cursor: 0, keys: [] });
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
  jest.useRealTimers();
});

it('matches global and affected subscription routes, including query variants, preserving other wallets', () => {
  const affected = new Set(['auto']);
  const paths = [
    '/api/subscriptions/upcoming-memes-counts',
    '/api/subscriptions/memes/558/count?x=1',
    '/api/subscriptions/consolidation/details/auto?x=1',
    '/api/subscriptions/consolidation/upcoming-memes/auto',
    '/api/subscriptions/consolidation/upcoming-memes/558/auto?x=1'
  ];
  for (const path of paths)
    expect(isSubscriptionCacheKey(prefix + path, prefix, affected)).toBe(true);
  for (const path of [
    '/api/subscriptions/consolidation/details/other',
    '/api/profiles/auto',
    '/api/subscriptions/memes/558'
  ])
    expect(isSubscriptionCacheKey(prefix + path, prefix, affected)).toBe(false);
  expect(
    isSubscriptionCacheKey('other-environment' + paths[0], prefix, affected)
  ).toBe(false);
});

it('scans once per cursor page for hundreds of wallets and deletes keys individually', async () => {
  const keys = Array.from(
    { length: 45 },
    (_, i) => `${prefix}/api/subscriptions/consolidation/details/wallet-${i}`
  );
  client.scan
    .mockResolvedValueOnce({ cursor: 42, keys })
    .mockResolvedValueOnce({
      cursor: 0,
      keys: [`${prefix}/api/subscriptions/consolidation/details/unrelated`]
    });
  const result = await evictSubscriptionCacheBatch(
    Array.from({ length: 800 }, (_, i) => `wallet-${i}`)
  );
  expect(client.scan).toHaveBeenCalledTimes(2);
  expect(client.del.mock.calls).toEqual(keys.map((key) => [key]));
  expect(result).toEqual(expect.objectContaining({ scanned: 46, deleted: 45 }));
  expect(client.disconnect).toHaveBeenCalledTimes(1);
  expect(createClient).toHaveBeenCalledWith(
    expect.objectContaining({
      disableOfflineQueue: true,
      socket: expect.objectContaining({ reconnectStrategy: false })
    })
  );
});

it('limits concurrent single-key deletes to twenty', async () => {
  let running = 0;
  let maximum = 0;
  client.scan.mockResolvedValue({
    cursor: 0,
    keys: Array.from(
      { length: 80 },
      (_, i) => `${prefix}/api/subscriptions/memes/${i}/count`
    )
  });
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

it('closes the owned connection at the deadline and stops subsequent pages and deletes', async () => {
  jest.useFakeTimers();
  let rejectScan: (error: Error) => void = () => {};
  client.scan.mockImplementation(
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
  const assertion = expect(attempt).rejects.toMatchObject({
    name: 'TimeoutError'
  });
  await jest.advanceTimersByTimeAsync(1500);
  await assertion;
  expect(client.disconnect).toHaveBeenCalledTimes(1);
  expect(client.scan).toHaveBeenCalledTimes(1);
  expect(client.del).not.toHaveBeenCalled();
});

it('closes only the owned connection on a command failure', async () => {
  client.scan.mockRejectedValue(new Error('Redis failed'));
  await expect(evictSubscriptionCacheBatch(['auto'])).rejects.toThrow(
    'Redis failed'
  );
  expect(client.disconnect).toHaveBeenCalledTimes(1);
});
