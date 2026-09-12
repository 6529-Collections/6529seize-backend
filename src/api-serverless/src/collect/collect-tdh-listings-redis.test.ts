import { CollectingFamily } from '@/collecting/collecting.types';

// Redis Cluster's documented CRC16-XMODEM hash-slot algorithm. This independent
// server-boundary model rejects cross-slot Lua calls instead of accepting every
// EVAL like the ordinary cache mocks do.
function hashSlot(key: string): number {
  const start = key.indexOf('{');
  const end = key.indexOf('}', start + 1);
  const payload =
    start >= 0 && end > start + 1 ? key.slice(start + 1, end) : key;
  let crc = 0;
  for (const byte of Array.from(Buffer.from(payload))) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
    }
  }
  return crc % 16384;
}

describe('TDH discovery on cluster-mode Redis', () => {
  const original = {
    FORCE_AVOID_REDIS: process.env.FORCE_AVOID_REDIS,
    REDIS_URL: process.env.REDIS_URL,
    REDIS_PORT: process.env.REDIS_PORT,
    NODE_ENV: process.env.NODE_ENV
  };

  beforeEach(() => {
    jest.resetModules();
    process.env.FORCE_AVOID_REDIS = 'false';
    process.env.REDIS_URL = 'localhost';
    process.env.REDIS_PORT = '6379';
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.entries(original).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });

  it('matches the published Redis CRC16 test vector and hash-tag behavior', () => {
    expect(hashSlot('123456789')).toBe(0x31c3);
    expect(hashSlot('prefix{123456789}:lease')).toBe(0x31c3);
    expect(hashSlot('prefix{}suffix')).not.toBe(hashSlot(''));
  });

  it.each<CollectingFamily>(['memes', 'gradients', 'pebbles'])(
    'publishes and reuses a %s snapshot without cross-slot Lua keys',
    async (family) => {
      const values = new Map<string, string>();
      const get = jest.fn(async (key: string) => values.get(key) ?? null);
      const set = jest.fn(
        async (key: string, value: string, options: { NX?: boolean }) => {
          if (options.NX && values.has(key)) return null;
          values.set(key, value);
          return 'OK';
        }
      );
      const evaluate = jest.fn(
        async (
          _script: string,
          input: { keys: string[]; arguments: string[] }
        ) => {
          if (new Set(input.keys.map(hashSlot)).size !== 1)
            throw new Error(
              "CROSSSLOT Keys in request don't hash to the same slot"
            );
          const [lease, cache] = input.keys;
          const [owner, value] = input.arguments;
          if (values.get(lease) !== owner) return 0;
          if (cache !== undefined) values.set(cache, value);
          values.delete(lease);
          return 1;
        }
      );
      jest.doMock('redis', () => ({
        createClient: jest.fn(() => ({
          get,
          set,
          eval: evaluate,
          connect: jest.fn(),
          on: jest.fn()
        }))
      }));
      const getCatalog = jest.fn(async () => ({
        version: 'catalog',
        chain_id: 1,
        assets: [],
        seasons: [],
        artists: [],
        pebbles_traits: [],
        tdh_snapshot: null
      }));
      jest.doMock('@/collecting/collecting.service', () => ({
        collectingService: { getCatalog }
      }));
      jest.doMock('@/api/market-depth/market-depth-api.db', () => ({
        marketDepthApiDb: { getBooks: jest.fn() }
      }));
      const redis = await import('@/redis');
      await redis.initRedis();
      const { getCollectTdhListings } =
        await import('./collect-tdh-listings.service');

      const snapshot = await getCollectTdhListings(family, 24);
      await expect(getCollectTdhListings(family, 24)).resolves.toEqual(
        snapshot
      );
      expect(getCatalog).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledTimes(1);
      const [lease, cache] = evaluate.mock.calls[0][1].keys;
      expect(cache).toBe(
        `__SEIZE_CACHE_development__collect/tdh-listings/v2/{${family}}`
      );
      expect(lease).toBe(`${cache}:refresh-lease`);
      expect(hashSlot(cache)).toBe(hashSlot(lease));
      expect(values.has(lease)).toBe(false);
      expect(values.has(cache)).toBe(true);
      const legacy = `__SEIZE_CACHE_development__collect/tdh-listings/v1/${family}`;
      expect(hashSlot(legacy)).not.toBe(hashSlot(`${legacy}:refresh-lease`));
    }
  );
});
