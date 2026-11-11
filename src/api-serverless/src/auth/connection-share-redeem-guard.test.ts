const getRedisClientMock = jest.fn();

jest.mock('@/redis', () => ({
  getRedisClient: () => getRedisClientMock()
}));

jest.mock('@/api/auth/auth', () => ({
  getJwtSecret: () => 'connection-share-redeem-guard-test-secret'
}));

import {
  CONNECTION_SHARE_REDEEM_FAILURE_LIMIT,
  CONNECTION_SHARE_REDEEM_FAILURE_WINDOW_SECONDS,
  isConnectionShareRedeemLimited,
  recordConnectionShareRedeem,
  recordFailedConnectionShareRedeem
} from './connection-share-redeem-guard';

/** Enough of a Redis client for SET NX EX + INCR in MULTI and GET. */
function fakeRedis() {
  const store = new Map<string, { value: number; ttl: number | null }>();
  const redis = {
    store,
    get: jest.fn(
      async (key: string) => store.get(key)?.value.toString() ?? null
    ),
    multi: jest.fn(() => {
      const ops: (() => unknown)[] = [];
      const chain = {
        set: (
          key: string,
          value: string,
          options: { NX?: boolean; EX?: number }
        ) => {
          ops.push(() => {
            if (options.NX && store.has(key)) {
              return null;
            }
            store.set(key, { value: Number(value), ttl: options.EX ?? null });
            return 'OK';
          });
          return chain;
        },
        incr: (key: string) => {
          ops.push(() => {
            const entry = store.get(key) ?? { value: 0, ttl: null };
            entry.value += 1;
            store.set(key, entry);
            return entry.value;
          });
          return chain;
        },
        exec: async () => ops.map((op) => op())
      };
      return chain;
    })
  };
  return redis;
}

describe('connection share redeem guard', () => {
  beforeEach(() => {
    getRedisClientMock.mockReset();
  });

  it('limits a source after the failure limit, within one expiring window', async () => {
    const redis = fakeRedis();
    getRedisClientMock.mockReturnValue(redis);

    for (let i = 1; i < CONNECTION_SHARE_REDEEM_FAILURE_LIMIT; i++) {
      await recordFailedConnectionShareRedeem('203.0.113.7');
    }
    await expect(isConnectionShareRedeemLimited('203.0.113.7')).resolves.toBe(
      false
    );
    await recordFailedConnectionShareRedeem('203.0.113.7');

    await expect(isConnectionShareRedeemLimited('203.0.113.7')).resolves.toBe(
      true
    );
    await expect(isConnectionShareRedeemLimited('203.0.113.8')).resolves.toBe(
      false
    );
    const entries = Array.from(redis.store.entries());
    expect(entries).toHaveLength(1);
    expect(entries[0][1]).toEqual({
      value: CONNECTION_SHARE_REDEEM_FAILURE_LIMIT,
      ttl: CONNECTION_SHARE_REDEEM_FAILURE_WINDOW_SECONDS
    });
    expect(entries[0][0]).not.toContain('203.0.113.7');
  });

  it('is off without Redis or without a source address', async () => {
    getRedisClientMock.mockReturnValue(null);
    await recordFailedConnectionShareRedeem('203.0.113.7');
    await expect(isConnectionShareRedeemLimited('203.0.113.7')).resolves.toBe(
      false
    );

    const redis = fakeRedis();
    getRedisClientMock.mockReturnValue(redis);
    await recordFailedConnectionShareRedeem('');
    await expect(isConnectionShareRedeemLimited('')).resolves.toBe(false);
    expect(redis.multi).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('fails open when Redis fails', async () => {
    getRedisClientMock.mockReturnValue({
      get: jest.fn().mockRejectedValue(new Error('down')),
      multi: jest.fn(() => {
        throw new Error('down');
      })
    });

    await expect(
      recordFailedConnectionShareRedeem('203.0.113.7')
    ).resolves.toBeUndefined();
    await expect(isConnectionShareRedeemLimited('203.0.113.7')).resolves.toBe(
      false
    );
  });

  it('writes one EMF line per redeem attempt', () => {
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      recordConnectionShareRedeem({
        target: 'native',
        outcome: 'ok',
        withDeviceSetup: true
      });
      expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual(
        expect.objectContaining({
          _type: '6529.connection_share_redeem.v1',
          Target: 'native',
          Outcome: 'ok',
          DeviceSetup: 'yes',
          ConnectionShareRedeems: 1
        })
      );
    } finally {
      write.mockRestore();
    }
  });
});
