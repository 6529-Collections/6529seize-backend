import { UserGroupEntity } from '@/entities/IUserGroup';
import {
  CatalogueProbe,
  CatalogueStamp,
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

  it('rebuilds itself after waiting at most 2 s for a peer', async () => {
    const { redis, process, load, sleeps } = setUp();
    redis.lease = 'held-forever';

    await expect(process().get()).resolves.toMatchObject({
      source: 'rebuilt'
    });
    expect(load).toHaveBeenCalledTimes(1);
    const waited = sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(waited).toBeGreaterThanOrEqual(2_000);
    expect(waited).toBeLessThan(2_100);
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

    it('uses a blob an older build wrote without a stamp but does not keep it', async () => {
      const { redis, process } = setUp();
      const a = process();
      await a.get();

      // The older build's rebuild: SET blob only; the previous stamp remains.
      redis.blob = JSON.stringify([group('g1'), group('older-build')]);

      const first = await a.get();
      expect(first.source).toBe('redis');
      expect(ids(first.groups)).toEqual(['g1', 'older-build']);
      await expect(a.get()).resolves.toMatchObject({ source: 'redis' });
    });
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
