import { RateLimitingService } from './rate-limiting.service';
import { RateLimitConfig } from './rate-limiting.utils';
import { getRedisClient, redisSortedSetAddAndCount } from '../../../redis';
import { RedisClientType } from 'redis';

jest.mock('../../../redis', () => ({
  ...jest.requireActual('../../../redis'),
  redisSortedSetAddAndCount: jest.fn(),
  getRedisClient: jest.fn()
}));

describe('RateLimitingService', () => {
  let service: RateLimitingService;
  let mockRedis: jest.Mocked<RedisClientType>;

  beforeEach(() => {
    service = new RateLimitingService();
    mockRedis = {
      multi: jest.fn(),
      zAdd: jest.fn(),
      zRemRangeByScore: jest.fn(),
      zCard: jest.fn(),
      expire: jest.fn()
    } as any;

    (getRedisClient as jest.Mock).mockReturnValue(mockRedis);
    (redisSortedSetAddAndCount as jest.Mock).mockClear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('checkRateLimit', () => {
    const config: RateLimitConfig = {
      burst: 30,
      sustainedRps: 10,
      sustainedWindowSeconds: 60
    };

    it('allows request when Redis is not available (fail open)', async () => {
      (getRedisClient as jest.Mock).mockReturnValue(null);

      const result = await service.checkRateLimit('test-identifier', config);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(config.burst);
      expect(result.limit).toBe(config.burst);
    });

    it('allows request when both burst and sustained limits are not exceeded', async () => {
      (redisSortedSetAddAndCount as jest.Mock)
        .mockResolvedValueOnce(15) // burst count
        .mockResolvedValueOnce(300); // sustained count

      const result = await service.checkRateLimit('test-identifier', config);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeLessThanOrEqual(config.burst);
    });

    it('blocks request when burst limit is exceeded', async () => {
      (redisSortedSetAddAndCount as jest.Mock).mockResolvedValue(35); // count = 35 > burst (30)

      const result = await service.checkRateLimit('test-identifier', config);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('blocks request when sustained limit is exceeded', async () => {
      (redisSortedSetAddAndCount as jest.Mock)
        .mockResolvedValueOnce(25) // burst OK
        .mockResolvedValueOnce(650); // 650 > 10*60 = 600

      const result = await service.checkRateLimit('test-identifier', config);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('handles Redis errors gracefully (fail open)', async () => {
      (getRedisClient as jest.Mock).mockReturnValue(mockRedis);
      (redisSortedSetAddAndCount as jest.Mock).mockRejectedValue(
        new Error('Redis error')
      );

      const result = await service.checkRateLimit('test-identifier', config);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(config.burst);
    });

    it('handles Redis errors gracefully', async () => {
      (getRedisClient as jest.Mock).mockReturnValue(mockRedis);
      (redisSortedSetAddAndCount as jest.Mock).mockRejectedValue(
        new Error('Redis error')
      );

      const result = await service.checkRateLimit('test-identifier', config);

      // Should fail open
      expect(result.allowed).toBe(true);
    });
  });

  describe('checkBurstLimit', () => {
    it('correctly calculates remaining requests', async () => {
      const limit = 30;
      const currentSecond = Math.floor(Date.now() / 1000);
      const count = 15;

      (redisSortedSetAddAndCount as jest.Mock).mockResolvedValue(count);

      // Access private method via any cast for testing
      const result = await (service as any).checkBurstLimit(
        'test-id',
        limit,
        currentSecond
      );

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(limit - count);
      expect(result.limit).toBe(limit);
    });

    it('blocks when count equals limit', async () => {
      const limit = 30;
      const currentSecond = Math.floor(Date.now() / 1000);
      const count = 30;

      (redisSortedSetAddAndCount as jest.Mock).mockResolvedValue(count);

      const result = await (service as any).checkBurstLimit(
        'test-id',
        limit,
        currentSecond
      );

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });

  describe('checkSustainedLimit', () => {
    it('correctly calculates remaining requests per second', async () => {
      const rpsLimit = 10;
      const windowSeconds = 60;
      const currentSecond = Math.floor(Date.now() / 1000);
      const count = 300; // 300 requests in 60 seconds = 5 req/sec

      (redisSortedSetAddAndCount as jest.Mock).mockResolvedValue(count);

      const result = await (service as any).checkSustainedLimit(
        'test-id',
        rpsLimit,
        windowSeconds,
        currentSecond
      );

      expect(result.allowed).toBe(true);
      // maxRequests = 10 * 60 = 600, remaining = 600 - 300 = 300, per second = 300/60 = 5
      expect(result.remaining).toBe(5);
      expect(result.limit).toBe(rpsLimit);
    });

    it('blocks when sustained limit is exceeded', async () => {
      const rpsLimit = 10;
      const windowSeconds = 60;
      const currentSecond = Math.floor(Date.now() / 1000);
      const count = 650; // 650 > 10 * 60 = 600

      (redisSortedSetAddAndCount as jest.Mock).mockResolvedValue(count);

      const result = await (service as any).checkSustainedLimit(
        'test-id',
        rpsLimit,
        windowSeconds,
        currentSecond
      );

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });
});

