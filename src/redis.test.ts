describe('evictAllKeysMatchingPatternFromRedisCache', () => {
  const originalForceAvoidRedis = process.env.FORCE_AVOID_REDIS;
  const originalRedisUrl = process.env.REDIS_URL;
  const originalRedisPort = process.env.REDIS_PORT;

  beforeEach(() => {
    jest.resetModules();
    process.env.FORCE_AVOID_REDIS = 'false';
    process.env.REDIS_URL = 'localhost';
    process.env.REDIS_PORT = '6379';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.FORCE_AVOID_REDIS = originalForceAvoidRedis;
    process.env.REDIS_URL = originalRedisUrl;
    process.env.REDIS_PORT = originalRedisPort;
  });

  it('stops scanning when redis returns the terminal cursor as a string', async () => {
    const scan = jest
      .fn()
      .mockResolvedValueOnce({
        cursor: '17',
        keys: ['cache:minting-claims:1']
      })
      .mockResolvedValueOnce({
        cursor: '0',
        keys: []
      });
    const del = jest.fn().mockResolvedValue(undefined);
    const connect = jest.fn().mockResolvedValue(undefined);
    const on = jest.fn();

    jest.doMock('redis', () => ({
      createClient: jest.fn(() => ({
        scan,
        del,
        connect,
        on
      }))
    }));

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
});
