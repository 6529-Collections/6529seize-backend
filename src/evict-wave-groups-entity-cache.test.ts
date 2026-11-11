jest.mock('redis', () => ({ createClient: jest.fn() }));

import { EventEmitter } from 'node:events';
import { redisKeySlot } from '@/tests/redis-key-slot';
import { createClient } from 'redis';
import {
  clearWaveGroupsCache,
  evictWaveGroupsEntityCache,
  initRedis,
  waitForRedisReady,
  WAVE_GROUPS_CACHE_GENERATION_KEY,
  WAVE_GROUPS_CACHE_KEY,
  WAVE_GROUPS_CACHE_REBUILD_LEASE_KEY,
  WAVE_GROUPS_CACHE_STAMP_KEY,
  WAVE_GROUPS_VERSION_CACHE_KEY
} from '@/redis';

describe('wave groups cache eviction helpers', () => {
  const events = new EventEmitter();
  const redisMock = {
    isReady: true,
    on: jest.fn((event: string, listener: () => void) => {
      events.on(event, listener);
    }),
    once: jest.fn((event: string, listener: () => void) => {
      events.once(event, listener);
    }),
    off: jest.fn((event: string, listener: () => void) => {
      events.off(event, listener);
    }),
    connect: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
    incr: jest.fn().mockResolvedValue(1),
    eval: jest.fn().mockResolvedValue(1)
  };
  const originalForceAvoidRedis = process.env.FORCE_AVOID_REDIS;
  const originalRedisUrl = process.env.REDIS_URL;

  beforeAll(async () => {
    delete process.env.FORCE_AVOID_REDIS;
    process.env.REDIS_URL = 'localhost';
    (createClient as jest.Mock).mockReturnValue(redisMock);
    await initRedis();
  });

  afterAll(() => {
    if (originalForceAvoidRedis === undefined) {
      delete process.env.FORCE_AVOID_REDIS;
    } else {
      process.env.FORCE_AVOID_REDIS = originalForceAvoidRedis;
    }
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  beforeEach(() => {
    redisMock.isReady = true;
    redisMock.del.mockClear();
    redisMock.incr.mockClear();
    redisMock.eval.mockClear();
  });

  const catalogueEviction = {
    keys: [
      WAVE_GROUPS_CACHE_KEY,
      WAVE_GROUPS_CACHE_GENERATION_KEY,
      WAVE_GROUPS_CACHE_STAMP_KEY
    ]
  };

  it('evictWaveGroupsEntityCache deletes the blob and its stamp, bumps the catalogue generation, and never bumps the version', async () => {
    await evictWaveGroupsEntityCache();
    expect(redisMock.eval).toHaveBeenCalledTimes(1);
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('INCR', KEYS[2])"),
      catalogueEviction
    );
    expect(redisMock.eval.mock.calls[0][0]).toContain(
      "redis.call('DEL', KEYS[1], KEYS[3])"
    );
    expect(redisMock.incr).not.toHaveBeenCalled();
  });

  it('clearWaveGroupsCache evicts the catalogue the same way and bumps the version', async () => {
    await clearWaveGroupsCache();
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('INCR', KEYS[2])"),
      catalogueEviction
    );
    expect(redisMock.incr).toHaveBeenCalledWith(WAVE_GROUPS_VERSION_CACHE_KEY);
  });

  it('keeps every catalogue key in the blob key cluster slot', () => {
    // Prod Redis is cluster mode: one script over keys in different slots
    // fails with CROSSSLOT. The new keys use the blob key's full name as hash
    // tag, so they hash exactly like the untagged blob key itself.
    expect(redisKeySlot('somekey')).toBe(11058);
    expect(redisKeySlot('foo{hash_tag}')).toBe(2515);
    const slot = redisKeySlot(WAVE_GROUPS_CACHE_KEY);
    for (const key of [
      WAVE_GROUPS_CACHE_GENERATION_KEY,
      WAVE_GROUPS_CACHE_STAMP_KEY,
      WAVE_GROUPS_CACHE_REBUILD_LEASE_KEY
    ])
      expect(redisKeySlot(key)).toBe(slot);
  });

  describe('waitForRedisReady', () => {
    it('returns at once for a ready client', async () => {
      await expect(waitForRedisReady(300)).resolves.toBe(true);
      expect(redisMock.once).not.toHaveBeenCalled();
    });

    it('waits for a connecting client to become ready', async () => {
      redisMock.isReady = false;
      const ready = waitForRedisReady(300);
      redisMock.isReady = true;
      events.emit('ready');
      await expect(ready).resolves.toBe(true);
    });

    it('gives up after the wait when the client never becomes ready', async () => {
      jest.useFakeTimers();
      try {
        redisMock.isReady = false;
        const ready = waitForRedisReady(300);
        jest.advanceTimersByTime(300);
        await expect(ready).resolves.toBe(false);
        expect(events.listenerCount('ready')).toBe(1); // only initRedis's own
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
