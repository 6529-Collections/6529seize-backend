/**
 * The API cache is ElastiCache Serverless, which runs in cluster mode: any
 * command (or MULTI, or script) whose keys hash to more than one slot fails
 * with CROSSSLOT. Before this guard the wave read caches used MGET across
 * slots and never served a hit. These tests run the real helpers and wave
 * caches against a client that enforces slots the same way.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const CROSSSLOT = "CROSSSLOT Keys in request don't hash to the same slot";

/** CRC16/XMODEM, as Redis Cluster uses it. */
function crc16(input: string): number {
  let crc = 0;
  const bytes = Buffer.from(input, 'utf8');
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Redis Cluster key slot, honouring the first non-empty `{hash tag}`. */
export function keySlot(key: string): number {
  const open = key.indexOf('{');
  if (open >= 0) {
    const close = key.indexOf('}', open + 1);
    if (close > open + 1) {
      return crc16(key.slice(open + 1, close)) % 16384;
    }
  }
  return crc16(key) % 16384;
}

function assertOneSlot(keys: string[]): void {
  if (new Set(keys.map(keySlot)).size > 1) {
    throw new Error(CROSSSLOT);
  }
}

function clusterClient() {
  const store = new Map<string, string>();
  const commands: { name: string; keys: string[] }[] = [];
  const run = <T>(name: string, keys: string[], fn: () => T): Promise<T> => {
    commands.push({ name, keys });
    try {
      assertOneSlot(keys);
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const asKeys = (keys: string | string[]) =>
    Array.isArray(keys) ? keys : [keys];
  const client = {
    isReady: true,
    store,
    commands,
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    get: (key: string) => run('GET', [key], () => store.get(key) ?? null),
    set: (key: string, value: string) =>
      run('SET', [key], () => {
        store.set(key, value);
        return 'OK';
      }),
    mGet: (keys: string[]) =>
      run('MGET', keys, () => keys.map((key) => store.get(key) ?? null)),
    del: (keys: string | string[]) =>
      run('DEL', asKeys(keys), () =>
        asKeys(keys).reduce((n, key) => n + (store.delete(key) ? 1 : 0), 0)
      ),
    exists: (keys: string | string[]) =>
      run(
        'EXISTS',
        asKeys(keys),
        () => asKeys(keys).filter((key) => store.has(key)).length
      ),
    eval: (_script: string, { keys }: { keys: string[] }) =>
      run('EVAL', keys, () => 1),
    scan: (_cursor: number, { MATCH }: { MATCH: string }) =>
      run('SCAN', [], () => {
        const pattern = new RegExp(
          `^${MATCH.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
        );
        return {
          cursor: 0,
          keys: Array.from(store.keys()).filter((key) => pattern.test(key))
        };
      })
  };
  return client;
}

type ClusterClient = ReturnType<typeof clusterClient>;

describe('Redis Cluster slot safety', () => {
  const originalEnv = { ...process.env };
  let client: ClusterClient;

  beforeEach(async () => {
    jest.resetModules();
    jest.useRealTimers();
    process.env.FORCE_AVOID_REDIS = 'false';
    process.env.REDIS_URL = 'localhost';
    process.env.REDIS_PORT = '6379';
    process.env.NODE_ENV = 'test';
    client = clusterClient();
    jest.doMock('redis', () => ({ createClient: jest.fn(() => client) }));
    const redis = await import('./redis');
    await redis.initRedis();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function multiSlotCommands() {
    return client.commands.filter(
      ({ keys }) => new Set(keys.map(keySlot)).size > 1
    );
  }

  it('computes Redis Cluster slots and rejects cross-slot commands', async () => {
    expect(keySlot('123456789')).toBe(crc16('123456789') % 16384);
    expect(crc16('123456789')).toBe(0x31c3);
    expect(keySlot('{user1000}.following')).toBe(
      keySlot('{user1000}.followers')
    );
    expect(keySlot('a{}b')).toBe(crc16('a{}b') % 16384);
    expect(keySlot('foo')).not.toBe(keySlot('bar'));
    await expect(client.mGet(['foo', 'bar'])).rejects.toThrow('CROSSSLOT');
  });

  it('keeps each multi-key script family in one slot', async () => {
    const { eligibleGroupsLeaseKeys } =
      await import('@/api/community-members/eligible-groups-lease');
    const keys = eligibleGroupsLeaseKeys('profile-1');
    expect(
      new Set([keys.result, keys.lease, keys.invalidation].map(keySlot)).size
    ).toBe(1);
    const legacy = 'opensea:market-depth:requests';
    expect(keySlot(`{${legacy}}:next-request`)).toBe(keySlot(legacy));
  });

  it('reads many keys across slots', async () => {
    const redis = await import('./redis');
    await client.set('foo', JSON.stringify({ a: 1 }));
    await client.set('bar', JSON.stringify({ b: 2 }));

    await expect(redis.redisGetMany(['foo', 'bar', 'baz'])).resolves.toEqual({
      foo: { a: 1 },
      bar: { b: 2 }
    });
    expect(multiSlotCommands()).toEqual([]);
  });

  it('evicts scanned keys across slots', async () => {
    const redis = await import('./redis');
    const keys = [
      '__SEIZE_CACHE_test__/api/drops/1',
      '__SEIZE_CACHE_test__/api/drops/1?page=2',
      '__SEIZE_CACHE_test__/api/drops/1?page=3'
    ];
    expect(new Set(keys.map(keySlot)).size).toBeGreaterThan(1);
    for (const key of keys) await client.set(key, '{}');

    await expect(
      redis.evictRedisCacheForPathWithTimeout({ path: '/api/drops/1' })
    ).resolves.toEqual(expect.objectContaining({ success: true }));
    expect(client.store.size).toBe(0);
    expect(multiSlotCommands()).toEqual([]);
  });

  it('runs the refresh-lease script only for hash-tagged keys', async () => {
    const redis = await import('./redis');
    const { Time } = await import('./time');
    const tagged = redis.getRedisCacheKeyForPath(
      'collect/tdh-listings/v2/{memes}'
    );

    await expect(
      redis.redisCachedWithRefreshLease(tagged, Time.seconds(60), async () => ({
        fresh: true
      }))
    ).resolves.toEqual({ fresh: true });
    expect(multiSlotCommands()).toEqual([]);

    // An untagged key splits the cache and its lease across slots.
    await expect(
      redis.redisCachedWithRefreshLease(
        'cache_untagged_example',
        Time.seconds(60),
        async () => 1
      )
    ).rejects.toThrow('CROSSSLOT');
  });

  it('serves wave unread summaries from the cache and retires them on change', async () => {
    const cache = await import('@/api/waves/wave-unread-cache');
    const { CACHE_VERSION_SETTLE_MS } =
      await import('@/api/waves/wave-cache-version');
    const waveIds = Array.from({ length: 12 }, (_, i) => `wave-${i}`);
    const summary = { unread_drops_count: 4, first_unread_drop_serial_no: 9 };

    const first = await cache.readWaveUnreadSummaryCache('reader-1', waveIds);
    expect(first.uncachedWaveIds).toEqual(waveIds);
    await cache.writeWaveUnreadSummaryCache({
      summariesByWaveId: Object.fromEntries(waveIds.map((id) => [id, summary])),
      cacheKeysByWaveId: first.cacheKeysByWaveId
    });
    const second = await cache.readWaveUnreadSummaryCache('reader-1', waveIds);
    expect(second.uncachedWaveIds).toEqual([]);
    expect(Object.keys(second.cachedByWaveId)).toEqual(waveIds);

    // A new drop in wave-3 (wave version), a mark-read in wave-5 (reader-wave
    // version) and a mute (reader-wide version) each retire the right entries.
    await cache.invalidateWaveUnreadCacheForWave('wave-3');
    await cache.invalidateWaveUnreadCacheForReaderWave({
      identityId: 'reader-1',
      waveId: 'wave-5'
    });
    const afterChange = await cache.readWaveUnreadSummaryCache(
      'reader-1',
      waveIds
    );
    expect(afterChange.uncachedWaveIds).toEqual(['wave-3', 'wave-5']);
    // Too recent to store: the change may not have replicated yet.
    expect(afterChange.cacheKeysByWaveId['wave-3']).toBeUndefined();

    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + CACHE_VERSION_SETTLE_MS + 1);
    const settled = await cache.readWaveUnreadSummaryCache('reader-1', waveIds);
    expect(settled.uncachedWaveIds).toEqual(['wave-3', 'wave-5']);
    expect(settled.cacheKeysByWaveId['wave-3']).toBeDefined();

    await cache.invalidateWaveUnreadCacheForReader('reader-1');
    const afterMute = await cache.readWaveUnreadSummaryCache('reader-1', [
      'wave-0'
    ]);
    expect(afterMute.uncachedWaveIds).toEqual(['wave-0']);

    expect(client.commands.some(({ name }) => name === 'MGET')).toBe(false);
    expect(multiSlotCommands()).toEqual([]);
  });

  it('serves wave overview static entries from the cache and retires them on edit', async () => {
    const cache = await import('@/api/waves/wave-overview-static-cache');
    const { CACHE_VERSION_SETTLE_MS } =
      await import('@/api/waves/wave-cache-version');
    const waves = Array.from({ length: 8 }, (_, i) => ({
      id: `wave-${i}`,
      created_by: 'creator',
      description_drop_id: `drop-${i}`,
      updated_at: 1
    })) as any[];
    const entry = {
      descriptionDropPartOne: null,
      descriptionDropPartOneMedia: []
    };

    const first = await cache.readWaveOverviewStaticCache(waves);
    await cache.writeWaveOverviewStaticCache({
      entriesByWaveId: Object.fromEntries(waves.map((w) => [w.id, entry])),
      cacheKeysByWaveId: first.cacheKeysByWaveId
    });
    const second = await cache.readWaveOverviewStaticCache(waves);
    expect(second.uncachedWaveIds).toEqual([]);

    await cache.invalidateWaveOverviewStaticCacheForDrops(['drop-2']);
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + CACHE_VERSION_SETTLE_MS + 1);
    const afterEdit = await cache.readWaveOverviewStaticCache(waves);
    expect(afterEdit.uncachedWaveIds).toEqual(['wave-2']);

    expect(multiSlotCommands()).toEqual([]);
  });
});

describe('Redis multi-key command guard', () => {
  const root = path.resolve(__dirname);

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        return name === 'node_modules' || name === 'generated'
          ? []
          : sourceFiles(full);
      }
      return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
    });
  }

  it('uses no MGET/MSET or multi-key DEL/EXISTS/UNLINK/TOUCH in application code', () => {
    const forbidden =
      /\.(?:mGet|mSet|mSetNX|MGET|MSET)\s*\(|\.(?:del|exists|unlink|touch)\s*\(\s*\[/;
    const offenders = sourceFiles(root)
      .filter((file) => forbidden.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});
