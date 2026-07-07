jest.mock('redis', () => ({ createClient: jest.fn() }));

import { createClient } from 'redis';
import {
  clearWaveGroupsCache,
  evictWaveGroupsEntityCache,
  initRedis,
  WAVE_GROUPS_CACHE_KEY,
  WAVE_GROUPS_VERSION_CACHE_KEY
} from '@/redis';

describe('wave groups cache eviction helpers', () => {
  const redisMock = {
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
    incr: jest.fn().mockResolvedValue(1)
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
    redisMock.del.mockClear();
    redisMock.incr.mockClear();
  });

  it('evictWaveGroupsEntityCache deletes only the entity blob and never bumps the version', async () => {
    await evictWaveGroupsEntityCache();
    expect(redisMock.del).toHaveBeenCalledWith(WAVE_GROUPS_CACHE_KEY);
    expect(redisMock.incr).not.toHaveBeenCalled();
  });

  it('clearWaveGroupsCache deletes the entity blob and bumps the version', async () => {
    await clearWaveGroupsCache();
    expect(redisMock.del).toHaveBeenCalledWith(WAVE_GROUPS_CACHE_KEY);
    expect(redisMock.incr).toHaveBeenCalledWith(WAVE_GROUPS_VERSION_CACHE_KEY);
  });
});
