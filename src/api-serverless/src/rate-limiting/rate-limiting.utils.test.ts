import { getRedisClient } from '../../../redis';
import {
  calculateRetryAfter,
  generateBurstKey,
  generateSustainedKey,
  getRateLimitConfig,
  sanitizeIdentifier
} from './rate-limiting.utils';

jest.mock('../../../redis');

describe('rate-limiting.utils', () => {
  describe('getRateLimitConfig', () => {
    const originalEnv = process.env;
    const mockGetRedisClient = getRedisClient as jest.MockedFunction<
      typeof getRedisClient
    >;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
      mockGetRedisClient.mockReturnValue({} as any);
    });

    afterEach(() => {
      process.env = originalEnv;
      jest.clearAllMocks();
    });

    it('returns disabled when env vars are not set (API_RATE_LIMIT_ENABLED must be true)', () => {
      delete process.env.API_RATE_LIMIT_ENABLED;
      delete process.env.RATE_LIMIT_AUTH_BURST;
      delete process.env.RATE_LIMIT_AUTH_SUSTAINED_RPS;
      delete process.env.RATE_LIMIT_AUTH_SUSTAINED_WINDOW_SECONDS;
      delete process.env.RATE_LIMIT_UNAUTH_BURST;
      delete process.env.RATE_LIMIT_UNAUTH_SUSTAINED_RPS;
      delete process.env.RATE_LIMIT_UNAUTH_SUSTAINED_WINDOW_SECONDS;

      const config = getRateLimitConfig();

      expect(config.enabled).toBe(false);
      expect(config.authenticated.burst).toBe(30);
      expect(config.authenticated.sustainedRps).toBe(10);
      expect(config.authenticated.sustainedWindowSeconds).toBe(60);
      expect(config.unauthenticated.burst).toBe(20);
      expect(config.unauthenticated.sustainedRps).toBe(5);
      expect(config.unauthenticated.sustainedWindowSeconds).toBe(60);
    });

    it('enables rate limiting when API_RATE_LIMIT_ENABLED is true and Redis is available', () => {
      process.env.API_RATE_LIMIT_ENABLED = 'true';
      process.env.RATE_LIMIT_AUTH_BURST = '50';
      process.env.RATE_LIMIT_AUTH_SUSTAINED_RPS = '20';
      process.env.RATE_LIMIT_AUTH_SUSTAINED_WINDOW_SECONDS = '120';
      process.env.RATE_LIMIT_UNAUTH_BURST = '30';
      process.env.RATE_LIMIT_UNAUTH_SUSTAINED_RPS = '10';
      process.env.RATE_LIMIT_UNAUTH_SUSTAINED_WINDOW_SECONDS = '90';
      mockGetRedisClient.mockReturnValue({} as any);

      const config = getRateLimitConfig();

      expect(config.enabled).toBe(true);
      expect(config.authenticated.burst).toBe(50);
      expect(config.authenticated.sustainedRps).toBe(20);
      expect(config.authenticated.sustainedWindowSeconds).toBe(120);
      expect(config.unauthenticated.burst).toBe(30);
      expect(config.unauthenticated.sustainedRps).toBe(10);
      expect(config.unauthenticated.sustainedWindowSeconds).toBe(90);
    });

    it('disables rate limiting when API_RATE_LIMIT_ENABLED is false', () => {
      process.env.API_RATE_LIMIT_ENABLED = 'false';
      mockGetRedisClient.mockReturnValue({} as any);

      const config = getRateLimitConfig();

      expect(config.enabled).toBe(false);
    });

    it('disables rate limiting when API_RATE_LIMIT_ENABLED is 0', () => {
      process.env.API_RATE_LIMIT_ENABLED = '0';
      mockGetRedisClient.mockReturnValue({} as any);

      const config = getRateLimitConfig();

      expect(config.enabled).toBe(false);
    });

    it('disables rate limiting when API_RATE_LIMIT_ENABLED is true but Redis is not available', () => {
      process.env.API_RATE_LIMIT_ENABLED = 'true';
      mockGetRedisClient.mockReturnValue(null);

      const config = getRateLimitConfig();

      expect(config.enabled).toBe(false);
    });

    it('disables rate limiting when API_RATE_LIMIT_ENABLED is not explicitly true', () => {
      process.env.API_RATE_LIMIT_ENABLED = 'yes';
      mockGetRedisClient.mockReturnValue({} as any);

      const config = getRateLimitConfig();

      expect(config.enabled).toBe(false);
    });
  });

  describe('generateBurstKey', () => {
    it('generates correct key format', () => {
      const key = generateBurstKey('test-identifier', 1234567890);
      expect(key).toBe('rate_limit:burst:test-identifier:1234567890');
    });
  });

  describe('generateSustainedKey', () => {
    it('generates correct key format', () => {
      const key = generateSustainedKey('test-identifier');
      expect(key).toBe('rate_limit:sustained:test-identifier');
    });
  });

  describe('calculateRetryAfter', () => {
    it('calculates correct retry after in seconds', () => {
      const now = Date.now();
      const resetTime = now + 5000; // 5 seconds from now

      const retryAfter = calculateRetryAfter(resetTime);

      expect(retryAfter).toBe(5);
    });

    it('returns at least 1 second even if reset time is in the past', () => {
      const now = Date.now();
      const resetTime = now - 1000; // 1 second ago

      const retryAfter = calculateRetryAfter(resetTime);

      expect(retryAfter).toBe(1);
    });

    it('rounds up fractional seconds', () => {
      const now = Date.now();
      const resetTime = now + 1500; // 1.5 seconds from now

      const retryAfter = calculateRetryAfter(resetTime);

      expect(retryAfter).toBe(2);
    });
  });

  describe('sanitizeIdentifier', () => {
    it('keeps alphanumeric and allowed special characters', () => {
      expect(sanitizeIdentifier('wallet:0x123abc')).toBe('wallet:0x123abc');
      expect(sanitizeIdentifier('ip:192.168.1.1')).toBe('ip:192.168.1.1');
    });

    it('replaces problematic characters with underscore', () => {
      expect(sanitizeIdentifier('test@example.com')).toBe('test_example.com');
      expect(sanitizeIdentifier('test#123')).toBe('test_123');
      expect(sanitizeIdentifier('test space')).toBe('test_space');
    });

    it('handles empty string', () => {
      expect(sanitizeIdentifier('')).toBe('');
    });

    it('handles string with only problematic characters', () => {
      expect(sanitizeIdentifier('@#$%')).toBe('____');
    });
  });
});
