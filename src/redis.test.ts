describe('redis cache eviction helpers', () => {
  const originalForceAvoidRedis = process.env.FORCE_AVOID_REDIS;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalRedisPort = process.env.REDIS_PORT;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.resetModules();
    jest.useRealTimers();
    process.env.FORCE_AVOID_REDIS = 'false';
    process.env.REDIS_URL = 'localhost';
    process.env.REDIS_PORT = '6379';
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    process.env.FORCE_AVOID_REDIS = originalForceAvoidRedis;
    process.env.REDIS_URL = originalRedisUrl;
    process.env.REDIS_PORT = originalRedisPort;
    process.env.NODE_ENV = originalNodeEnv;
  });

  function mockRedisClient({
    scan,
    del = jest.fn().mockResolvedValue(undefined),
    connect = jest.fn().mockResolvedValue(undefined),
    on = jest.fn()
  }: {
    scan: jest.Mock;
    del?: jest.Mock;
    connect?: jest.Mock;
    on?: jest.Mock;
  }) {
    jest.doMock('redis', () => ({
      createClient: jest.fn(() => ({
        scan,
        del,
        connect,
        on
      }))
    }));

    return { scan, del, connect, on };
  }

  it('stops scanning when redis returns the terminal cursor as a string', async () => {
    const { scan, del, connect } = mockRedisClient({
      scan: jest
        .fn()
        .mockResolvedValueOnce({
          cursor: '17',
          keys: ['cache:minting-claims:1']
        })
        .mockResolvedValueOnce({
          cursor: '0',
          keys: []
        })
    });

    const redisModule = await import('./redis');

    await redisModule.initRedis();
    await redisModule.evictAllKeysMatchingPatternFromRedisCache(
      'cache:minting-claims:*'
    );

    expect(connect).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan).toHaveBeenNthCalledWith(1, 0, {
      MATCH: 'cache:minting-claims:*',
      COUNT: 1000
    });
    expect(scan).toHaveBeenNthCalledWith(2, 17, {
      MATCH: 'cache:minting-claims:*',
      COUNT: 1000
    });
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(['cache:minting-claims:1']);
  });

  it('evictRedisCacheForPath scans using the derived wildcard key pattern', async () => {
    const { scan, del, connect } = mockRedisClient({
      scan: jest
        .fn()
        .mockResolvedValueOnce({
          cursor: '12',
          keys: ['__SEIZE_CACHE_test__/api/minting-claims/1']
        })
        .mockResolvedValueOnce({
          cursor: '0',
          keys: []
        })
    });

    const redisModule = await import('./redis');

    await redisModule.initRedis();
    await redisModule.evictRedisCacheForPath('/api/minting-claims/1');

    expect(connect).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenNthCalledWith(1, 0, {
      MATCH: '__SEIZE_CACHE_test__/api/minting-claims/1*',
      COUNT: 1000
    });
    expect(scan).toHaveBeenNthCalledWith(2, 12, {
      MATCH: '__SEIZE_CACHE_test__/api/minting-claims/1*',
      COUNT: 1000
    });
    expect(del).toHaveBeenCalledWith([
      '__SEIZE_CACHE_test__/api/minting-claims/1'
    ]);
  });

  it('evictRedisCacheForPathWithTimeout returns scan errors', async () => {
    const scanError = new Error('scan failed');
    const { connect } = mockRedisClient({
      scan: jest.fn().mockRejectedValue(scanError)
    });

    const redisModule = await import('./redis');

    await redisModule.initRedis();
    const result = await redisModule.evictRedisCacheForPathWithTimeout({
      path: '/api/minting-claims/1',
      timeoutMs: 50
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe(scanError);
    }
  });

  it('evictRedisCacheForPathWithTimeout returns timeout failures', async () => {
    const { connect } = mockRedisClient({
      scan: jest.fn().mockImplementation(() => new Promise(() => {}))
    });

    const redisModule = await import('./redis');

    await redisModule.initRedis();
    const result = await redisModule.evictRedisCacheForPathWithTimeout({
      path: '/api/minting-claims/1',
      timeoutMs: 1
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(String(result.error)).toContain('Timed out after 1ms');
    }
  });
});
