import fc from 'fast-check';
import type { RedisFailFastOptions } from './redis';

const FAIL_FAST: RedisFailFastOptions = {
  commandTimeoutMs: 40,
  connectTimeoutMs: 1_000,
  initialConnectTimeoutMs: 40,
  maxReconnectDelayMs: 2_000
};
// Generous ceiling for "returned within the budget" on a loaded CI worker;
// without fail-fast these calls never settle at all.
const WITHIN_BUDGET_MS = 1_000;

const never = <T>() => new Promise<T>(() => undefined);

type ClientOptions = {
  disableOfflineQueue?: boolean;
  socket: {
    connectTimeout?: number;
    reconnectStrategy?: (retries: number) => number;
  };
};

type MockClient = {
  isReady: boolean;
  on: jest.Mock;
  connect: jest.Mock;
  get: jest.Mock;
  set: jest.Mock;
  mGet: jest.Mock;
  multi: jest.Mock;
  exec: jest.Mock;
};

function mockRedisClient(overrides: Partial<MockClient> = {}) {
  const exec = overrides.exec ?? jest.fn().mockResolvedValue([1, 0, 1, 1]);
  const pipeline = {
    zAdd: jest.fn(),
    zRemRangeByScore: jest.fn(),
    zCard: jest.fn(),
    expire: jest.fn(),
    exec
  };
  const client: MockClient = {
    isReady: true,
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    mGet: jest.fn().mockResolvedValue([]),
    multi: jest.fn(() => pipeline),
    exec,
    ...overrides
  };
  const createClient = jest.fn((_options: ClientOptions) => client);
  jest.doMock('redis', () => ({ createClient }));
  return { client, createClient };
}

async function timed<T>(promise: Promise<T>) {
  const startedAt = Date.now();
  const value = await promise;
  return { value, elapsedMs: Date.now() - startedAt };
}

describe('redis fail-fast mode', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env.FORCE_AVOID_REDIS = 'false';
    process.env.REDIS_URL = 'localhost';
    process.env.REDIS_PORT = '6379';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('configures a bounded, non-queueing client only when fail-fast is requested', async () => {
    const { createClient } = mockRedisClient();
    const redisModule = await import('./redis');

    await redisModule.initRedis({ failFast: FAIL_FAST });

    const options = createClient.mock.calls[0][0];
    expect(options.disableOfflineQueue).toBe(true);
    expect(options.socket.connectTimeout).toBe(FAIL_FAST.connectTimeoutMs);
    expect(options.socket.reconnectStrategy?.(0)).toBe(50);
    expect(options.socket.reconnectStrategy?.(50)).toBe(
      FAIL_FAST.maxReconnectDelayMs
    );
  });

  it('keeps node-redis defaults for callers that do not opt in', async () => {
    const { createClient, client } = mockRedisClient({
      get: jest.fn().mockRejectedValue(new Error('READONLY'))
    });
    const redisModule = await import('./redis');

    await redisModule.initRedis();

    const options = createClient.mock.calls[0][0];
    expect(options.disableOfflineQueue).toBeUndefined();
    expect(options.socket.connectTimeout).toBeUndefined();
    expect(options.socket.reconnectStrategy).toBeUndefined();
    client.isReady = false;
    await expect(redisModule.redisGet('key')).rejects.toThrow('READONLY');
    expect(client.get).toHaveBeenCalledWith('key');
  });

  it('keeps fail-fast helper budgets regardless of initialization order', async () => {
    const { client, createClient } = mockRedisClient({
      get: jest.fn(() => never())
    });
    const redisModule = await import('./redis');

    await redisModule.initRedis();
    await redisModule.initRedis({ failFast: FAIL_FAST });
    await redisModule.initRedis();

    expect(createClient).toHaveBeenCalledTimes(1);
    const { value, elapsedMs } = await timed(redisModule.redisGet('key'));
    expect(value).toBeNull();
    expect(elapsedMs).toBeLessThan(WITHIN_BUDGET_MS);
    expect(client.get).toHaveBeenCalledWith('key');
  });

  it('starts within the initial budget when Redis never becomes reachable', async () => {
    const { client } = mockRedisClient({
      isReady: false,
      connect: jest.fn(() => never())
    });
    const redisModule = await import('./redis');

    const { elapsedMs } = await timed(
      redisModule.initRedis({ failFast: FAIL_FAST })
    );

    expect(elapsedMs).toBeLessThan(WITHIN_BUDGET_MS);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(redisModule.getRedisClient()).toBe(client);
    await expect(redisModule.redisGet('key')).resolves.toBeNull();
    expect(client.get).not.toHaveBeenCalled();
  });

  it('treats a hanging GET as a cache miss within the command budget', async () => {
    const { client } = mockRedisClient({ get: jest.fn(() => never()) });
    const redisModule = await import('./redis');
    await redisModule.initRedis({ failFast: FAIL_FAST });

    const { value, elapsedMs } = await timed(redisModule.redisGet('key'));

    expect(value).toBeNull();
    expect(elapsedMs).toBeGreaterThanOrEqual(FAIL_FAST.commandTimeoutMs - 5);
    expect(elapsedMs).toBeLessThan(WITHIN_BUDGET_MS);
    expect(client.get).toHaveBeenCalledWith('key');
  });

  it('treats hanging MGET and SET as a miss and a skipped write', async () => {
    mockRedisClient({
      mGet: jest.fn(() => never()),
      set: jest.fn(() => never())
    });
    const redisModule = await import('./redis');
    await redisModule.initRedis({ failFast: FAIL_FAST });

    const many = await timed(redisModule.redisGetMany(['a', 'b']));
    const write = await timed(redisModule.redisSetJson('key', { a: 1 }));

    expect(many.value).toEqual({});
    expect(many.elapsedMs).toBeLessThan(WITHIN_BUDGET_MS);
    expect(write.value).toBeUndefined();
    expect(write.elapsedMs).toBeLessThan(WITHIN_BUDGET_MS);
  });

  it('still serves values and propagates real Redis errors when connected', async () => {
    mockRedisClient({
      get: jest.fn().mockResolvedValue(JSON.stringify({ hit: true })),
      mGet: jest.fn().mockRejectedValue(new Error('WRONGTYPE'))
    });
    const redisModule = await import('./redis');
    await redisModule.initRedis({ failFast: FAIL_FAST });

    await expect(redisModule.redisGet('key')).resolves.toEqual({ hit: true });
    await expect(redisModule.redisGetMany(['key'])).rejects.toThrow(
      'WRONGTYPE'
    );
  });

  it('rejects a hanging rate-limit pipeline with RedisUnavailableError', async () => {
    mockRedisClient({ exec: jest.fn(() => never()) });
    const redisModule = await import('./redis');
    await redisModule.initRedis({ failFast: FAIL_FAST });

    const startedAt = Date.now();
    await expect(
      redisModule.redisSortedSetAddAndCount('k', 1, 'v', 0, 2)
    ).rejects.toBeInstanceOf(redisModule.RedisUnavailableError);
    expect(Date.now() - startedAt).toBeLessThan(WITHIN_BUDGET_MS);
  });

  it('caps reconnect backoff without ever giving up', async () => {
    const { failFastReconnectDelayMs } = await import('./redis');
    fc.assert(
      fc.property(
        fc.nat({ max: 10_000 }),
        fc.integer({ min: 50, max: 60_000 }),
        (retries, maxDelayMs) => {
          const delay = failFastReconnectDelayMs(retries, maxDelayMs);
          expect(Number.isFinite(delay)).toBe(true);
          expect(delay).toBeGreaterThan(0);
          expect(delay).toBeLessThanOrEqual(maxDelayMs);
          expect(failFastReconnectDelayMs(retries + 1, maxDelayMs)).toBe(
            Math.min(delay * 2, maxDelayMs)
          );
        }
      )
    );
  });
});
