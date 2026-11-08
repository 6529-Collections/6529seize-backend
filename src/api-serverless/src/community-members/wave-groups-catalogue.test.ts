import { UserGroupEntity } from '@/entities/IUserGroup';
import { redisKeySlot } from '@/tests/redis-key-slot';
import {
  CatalogueProbe,
  CatalogueStamp,
  RedisWaveGroupsCatalogueStore,
  WaveGroupsCatalogue,
  WaveGroupsCatalogueStore
} from './wave-groups-catalogue';

const TTL_SEC = 60;

function group(id: string): UserGroupEntity {
  return { id, name: id, visible: true } as unknown as UserGroupEntity;
}

/** Redis as the catalogue sees it, shared by every simulated process. */
class SharedRedis {
  blob: string | null = null;
  stamp: CatalogueStamp | null = null;
  generation = 0;
  lease: string | null = null;
  blobReads = 0;
  publishes = 0;
  private leases = 0;

  /** An eviction by this build: one script bumps the generation and deletes both. */
  evict() {
    this.generation++;
    this.blob = null;
    this.stamp = null;
  }

  /** Both keys share one TTL, so they expire together; the generation stays. */
  expire() {
    this.blob = null;
    this.stamp = null;
  }

  store(): WaveGroupsCatalogueStore {
    return {
      probe: async (): Promise<CatalogueProbe> => ({
        bytes: this.blob ? Buffer.byteLength(this.blob, 'utf8') : 0,
        stamp: this.stamp,
        generation: String(this.generation)
      }),
      readBlob: async () => {
        this.blobReads++;
        return this.blob;
      },
      acquireRebuildLease: async () => {
        if (this.lease) return null;
        this.lease = `lease-${++this.leases}`;
        return this.lease;
      },
      releaseRebuildLease: async (token) => {
        if (this.lease === token) this.lease = null;
      },
      publish: async ({ payload, stamp, leaseToken }) => {
        if (String(this.generation) !== stamp.generation) return false;
        this.blob = payload;
        this.stamp = stamp;
        if (leaseToken && this.lease === leaseToken) this.lease = null;
        this.publishes++;
        return true;
      }
    };
  }
}

function setUp() {
  const redis = new SharedRedis();
  const clock = { now: 1_000_000 };
  let dbGroups = [group('g1')];
  const load = jest.fn(async () => dbGroups.map((it) => ({ ...it })));
  const onSleep: Array<() => void> = [];
  const sleeps: number[] = [];
  const process = () =>
    new WaveGroupsCatalogue({
      store: () => redis.store(),
      load,
      ttlSec: () => TTL_SEC,
      freezeShared: true,
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.now += ms;
        onSleep.shift()?.();
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
  return {
    redis,
    clock,
    load,
    sleeps,
    onSleep,
    process,
    setDb: (groups: UserGroupEntity[]) => {
      dbGroups = groups;
    }
  };
}

const ids = (groups: UserGroupEntity[]) => groups.map((it) => it.id);

describe('WaveGroupsCatalogue', () => {
  it('serves its memory copy while the stamp names the same content', async () => {
    const { redis, load, process } = setUp();
    const a = process();
    const b = process();

    const first = await a.get();
    expect(first).toMatchObject({ source: 'rebuilt', redisBytes: 0 });
    expect(await a.get()).toMatchObject({ source: 'memory', redisBytes: 0 });

    const fromRedis = await b.get();
    expect(fromRedis.source).toBe('redis');
    expect(fromRedis.redisBytes).toBe(Buffer.byteLength(redis.blob!, 'utf8'));
    expect(await b.get()).toMatchObject({ source: 'memory', redisBytes: 0 });
    expect(redis.blobReads).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps its copy when unchanged content is republished after expiry', async () => {
    const { redis, clock, process } = setUp();
    const a = process();
    const b = process();
    await a.get();
    await b.get();
    const reads = redis.blobReads;

    clock.now += (TTL_SEC + 10) * 1_000;
    redis.expire();
    await expect(a.get()).resolves.toMatchObject({ source: 'rebuilt' });

    // Same generation and hash: B never transfers the blob again.
    await expect(b.get()).resolves.toMatchObject({ source: 'memory' });
    expect(redis.blobReads).toBe(reads);
  });

  it('refetches when the stamp names different content', async () => {
    const { redis, process, setDb } = setUp();
    const a = process();
    const b = process();
    await a.get();

    setDb([group('g1'), group('g2')]);
    redis.evict();
    await b.get();

    const next = await a.get();
    expect(next.source).toBe('redis');
    expect(ids(next.groups)).toEqual(['g1', 'g2']);
  });

  it('never serves its copy after an explicit eviction: a new group is eligible at once', async () => {
    const { redis, process, setDb } = setUp();
    const a = process();
    await a.get();

    setDb([group('g1'), group('new-group')]);
    redis.evict();

    const next = await a.get();
    expect(next.source).toBe('rebuilt');
    expect(ids(next.groups)).toContain('new-group');
  });

  it('after an explicit eviction, waits for the rebuilding request instead of serving its copy', async () => {
    const { redis, process, setDb, onSleep } = setUp();
    const a = process();
    const b = process();
    await a.get();

    setDb([group('g1'), group('new-group')]);
    redis.evict();
    redis.lease = 'held-by-b';
    // B finishes its rebuild while A polls.
    onSleep.push(() => {
      void (async () => {
        redis.lease = null;
        await b.get();
      })();
    });

    const next = await a.get();
    expect(['peer', 'rebuilt']).toContain(next.source);
    expect(ids(next.groups)).toContain('new-group');
  });

  it('serves its copy for a few seconds after the blob expired while another request rebuilds', async () => {
    const { redis, clock, process, sleeps } = setUp();
    const a = process();
    await a.get();

    clock.now += TTL_SEC * 1_000 + 1_000;
    redis.expire();
    redis.lease = 'held-by-peer';

    await expect(a.get()).resolves.toMatchObject({
      source: 'stale_after_expiry',
      redisBytes: 0
    });
    expect(sleeps).toEqual([]);
  });

  it('stops serving its copy more than a few seconds after the expiry', async () => {
    const { redis, clock, process, load } = setUp();
    const a = process();
    await a.get();

    clock.now += TTL_SEC * 1_000 + 6_000;
    redis.expire();
    redis.lease = 'held-by-peer';

    // Waits for the peer, then rebuilds itself after the bounded wait.
    const next = await a.get();
    expect(next.source).toBe('rebuilt');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rebuilds once for concurrent computations across processes', async () => {
    const { redis, process, load, onSleep } = setUp();
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    load.mockImplementationOnce(async () => {
      await loadGate;
      return [group('g1')];
    });
    onSleep.push(() => releaseLoad());

    const a = process();
    const b = process();
    const c = process();
    const results = await Promise.all([a.get(), a.get(), b.get(), c.get()]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(redis.publishes).toBe(1);
    for (const result of results) expect(ids(result.groups)).toEqual(['g1']);
    expect(results.filter((it) => it.source === 'rebuilt')).not.toHaveLength(0);
  });

  it('does not publish a catalogue loaded before an eviction', async () => {
    const { redis, process, load, setDb } = setUp();
    const a = process();
    load.mockImplementationOnce(async () => {
      // The eviction lands while the database read is in progress.
      setDb([group('g1'), group('new-group')]);
      redis.evict();
      return [group('g1')];
    });

    await expect(a.get()).resolves.toMatchObject({ source: 'rebuilt' });
    expect(redis.blob).toBeNull();
    expect(redis.lease).toBeNull();

    // Nothing stale was kept: the next request rebuilds with the new group.
    const next = await a.get();
    expect(ids(next.groups)).toContain('new-group');
  });

  it('takes the rebuild over when the rebuilding request disappears', async () => {
    const { redis, process, load, onSleep } = setUp();
    redis.lease = 'held-by-dead-peer';
    onSleep.push(() => undefined);
    onSleep.push(() => {
      redis.lease = null; // the lease expired
    });

    const next = await process().get();
    expect(next.source).toBe('rebuilt');
    expect(load).toHaveBeenCalledTimes(1);
    expect(redis.publishes).toBe(1);
  });

  it('keeps waiting while a live holder has the lease, up to the 12 s eligibility budget', async () => {
    const { redis, process, load, sleeps } = setUp();
    redis.lease = 'held-forever';

    await expect(process().get()).resolves.toMatchObject({
      source: 'rebuilt'
    });
    expect(load).toHaveBeenCalledTimes(1);
    const waited = sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(waited).toBeGreaterThanOrEqual(12_000);
    expect(waited).toBeLessThan(12_100);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThanOrEqual(25);
      expect(ms).toBeLessThanOrEqual(50);
    }
  });

  describe('rolling deploy with an older build', () => {
    it('never serves its copy after an older build deleted only the blob', async () => {
      const { redis, process, setDb } = setUp();
      const a = process();
      await a.get();

      setDb([group('g1'), group('new-group')]);
      redis.blob = null; // the older build's eviction: DEL blob, no stamp, no generation
      redis.lease = 'held-by-peer';

      const next = await a.get();
      expect(next.source).not.toBe('memory');
      expect(next.source).not.toBe('stale_after_expiry');
      expect(ids(next.groups)).toContain('new-group');
    });

    it('never serves a blob an older build wrote over a stamped one: rebuilds and overwrites it', async () => {
      const { redis, process, setDb } = setUp();
      const a = process();
      await a.get();

      // The older build's rebuild: SET blob only; the previous stamp remains.
      redis.blob = JSON.stringify([group('g1'), group('older-build')]);
      setDb([group('g1'), group('current')]);

      const next = await a.get();
      expect(next.source).toBe('rebuilt');
      expect(ids(next.groups)).toEqual(['g1', 'current']);
      expect(redis.stamp?.bytes).toBe(Buffer.byteLength(redis.blob!, 'utf8'));
      await expect(a.get()).resolves.toMatchObject({ source: 'memory' });
    });

    it("never serves an older build's pre-eviction catalogue written between two evictions", async () => {
      const { redis, clock, process, setDb, onSleep, load } = setUp();
      const a = process();
      const b = process();
      await a.get();
      await b.get();
      const preEviction = JSON.stringify([group('g1')]);

      // A DM is created: its group, then its wave, each evicts. An older
      // build loaded the catalogue before the second eviction and SETs it
      // afterwards, without a stamp.
      setDb([group('g1'), group('new-dm-group')]);
      redis.evict();
      redis.evict();
      redis.blob = preEviction;

      const direct = await a.get();
      expect(direct.source).toBe('rebuilt');
      expect(ids(direct.groups)).toContain('new-dm-group');

      // The same through the peer wait: while another request holds the
      // lease, B waits past the unstamped blob and takes only the stamped one.
      redis.evict();
      redis.blob = preEviction;
      redis.lease = 'held-by-peer';
      const current = JSON.stringify([group('g1'), group('new-dm-group')]);
      onSleep.push(() => undefined); // one poll sees only the unstamped blob
      onSleep.push(() => {
        // The peer publishes its stamped rebuild and releases the lease.
        redis.blob = current;
        redis.stamp = {
          generation: String(redis.generation),
          hash: 'peer',
          bytes: Buffer.byteLength(current, 'utf8'),
          publishedAt: clock.now
        };
        redis.lease = null;
      });

      const viaPeer = await b.get();
      expect(viaPeer.source).toBe('peer');
      expect(ids(viaPeer.groups)).toEqual(['g1', 'new-dm-group']);
      expect(load).toHaveBeenCalledTimes(2); // A's two builds, none by B
    });

    it('rebuilds a blob whose size does not match its stamp instead of serving it', async () => {
      const { redis, process, setDb } = setUp();
      const a = process();
      await process().get();

      setDb([group('g1'), group('current')]);
      redis.blob = JSON.stringify([group('g1'), group('other-size')]);

      const next = await a.get();
      expect(next.source).toBe('rebuilt');
      expect(ids(next.groups)).toEqual(['g1', 'current']);
    });
  });

  it('touches only keys in one cluster slot in every Redis call', async () => {
    // Prod Redis is cluster mode: a script whose keys span slots fails with
    // CROSSSLOT, which would fail eligibility closed.
    const touched: string[][] = [];
    const client = {
      eval: jest.fn(async (_script: string, options: { keys: string[] }) => {
        touched.push(options.keys);
        return 1;
      }),
      get: jest.fn(async (key: string) => {
        touched.push([key]);
        return null;
      }),
      set: jest.fn(async (key: string) => {
        touched.push([key]);
        return 'OK';
      })
    };
    const store = new RedisWaveGroupsCatalogueStore(client as never);
    await store.probe();
    await store.readBlob();
    const token = (await store.acquireRebuildLease())!;
    await store.publish({
      payload: '[]',
      stamp: { generation: '0', hash: 'h', bytes: 2, publishedAt: 1 },
      ttlSec: TTL_SEC,
      leaseToken: token
    });
    await store.releaseRebuildLease(token);

    expect(touched.length).toBeGreaterThanOrEqual(5);
    const slots = new Set(touched.flat().map(redisKeySlot));
    expect(slots.size).toBe(1);
  });

  it('does not rebuild once the eligibility request was aborted', async () => {
    const { redis, process, load, onSleep } = setUp();
    redis.lease = 'held-by-peer';
    const controller = new AbortController();
    onSleep.push(() => controller.abort());

    await expect(process().get({ signal: controller.signal })).rejects.toThrow(
      'aborted'
    );
    expect(load).not.toHaveBeenCalled();
  });

  it('freezes the shared catalogue under tests, so a caller cannot change it', async () => {
    const { process } = setUp();
    const a = process();
    const { groups } = await a.get();
    expect(Object.isFrozen(groups)).toBe(true);
    expect(Object.isFrozen(groups[0])).toBe(true);
    expect(() => {
      (groups as UserGroupEntity[]).push(group('mutation'));
    }).toThrow(TypeError);
    const fromRedis = await process().get();
    expect(Object.isFrozen(fromRedis.groups)).toBe(true);
  });

  it('loads from the database each time without Redis', async () => {
    const { load } = setUp();
    const catalogue = new WaveGroupsCatalogue({
      store: () => null,
      load,
      ttlSec: () => TTL_SEC
    });
    await catalogue.get();
    await catalogue.get();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
