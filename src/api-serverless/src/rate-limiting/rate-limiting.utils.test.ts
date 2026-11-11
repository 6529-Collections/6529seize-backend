import * as fc from 'fast-check';
import { getRedisClient } from '../../../redis';
import {
  calculateRetryAfter,
  generateBurstKey,
  generateSustainedKey,
  getRateLimitConfig,
  IPV6_UNPARSED_KEY,
  ipv6RateLimitKey,
  isSignInRequest,
  rateLimitAddressKey,
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
      delete process.env.API_RATE_LIMIT_AUTH_BURST;
      delete process.env.API_RATE_LIMIT_AUTH_SUSTAINED_RPS;
      delete process.env.API_RATE_LIMIT_AUTH_SUSTAINED_WINDOW_SECONDS;
      delete process.env.API_RATE_LIMIT_UNAUTH_BURST;
      delete process.env.API_RATE_LIMIT_UNAUTH_SUSTAINED_RPS;
      delete process.env.API_RATE_LIMIT_UNAUTH_SUSTAINED_WINDOW_SECONDS;
      delete process.env.API_RATE_LIMIT_INTERNAL_ID;
      delete process.env.API_RATE_LIMIT_INTERNAL_SECRET;

      const config = getRateLimitConfig();

      expect(config.enabled).toBe(false);
      expect(config.authenticated.burst).toBe(45);
      expect(config.authenticated.sustainedRps).toBe(15);
      expect(config.authenticated.sustainedWindowSeconds).toBe(60);
      expect(config.unauthenticated.burst).toBe(30);
      expect(config.unauthenticated.sustainedRps).toBe(10);
      expect(config.unauthenticated.sustainedWindowSeconds).toBe(60);
      expect(config.internal.enabled).toBe(false);
      expect(config.internal.clientId).toBeNull();
      expect(config.internal.secret).toBeNull();
    });

    it('enables rate limiting when API_RATE_LIMIT_ENABLED is true and Redis is available', () => {
      process.env.API_RATE_LIMIT_ENABLED = 'true';
      process.env.API_RATE_LIMIT_AUTH_BURST = '50';
      process.env.API_RATE_LIMIT_AUTH_SUSTAINED_RPS = '20';
      process.env.API_RATE_LIMIT_AUTH_SUSTAINED_WINDOW_SECONDS = '120';
      process.env.API_RATE_LIMIT_UNAUTH_BURST = '30';
      process.env.API_RATE_LIMIT_UNAUTH_SUSTAINED_RPS = '10';
      process.env.API_RATE_LIMIT_UNAUTH_SUSTAINED_WINDOW_SECONDS = '90';
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

    it('enables internal config when both ID and secret are provided', () => {
      process.env.API_RATE_LIMIT_INTERNAL_ID = 'test-id';
      process.env.API_RATE_LIMIT_INTERNAL_SECRET = 'test-secret';
      mockGetRedisClient.mockReturnValue({} as any);

      const config = getRateLimitConfig();

      expect(config.internal.enabled).toBe(true);
      expect(config.internal.clientId).toBe('test-id');
      expect(config.internal.secret).toBe('test-secret');
    });

    it('disables internal config when ID is missing', () => {
      delete process.env.API_RATE_LIMIT_INTERNAL_ID;
      process.env.API_RATE_LIMIT_INTERNAL_SECRET = 'test-secret';
      mockGetRedisClient.mockReturnValue({} as any);

      const config = getRateLimitConfig();

      expect(config.internal.enabled).toBe(false);
      expect(config.internal.clientId).toBeNull();
      expect(config.internal.secret).toBe('test-secret');
    });

    it('disables internal config when secret is missing', () => {
      process.env.API_RATE_LIMIT_INTERNAL_ID = 'test-id';
      delete process.env.API_RATE_LIMIT_INTERNAL_SECRET;
      mockGetRedisClient.mockReturnValue({} as any);

      const config = getRateLimitConfig();

      expect(config.internal.enabled).toBe(false);
      expect(config.internal.clientId).toBe('test-id');
      expect(config.internal.secret).toBeNull();
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

  describe('per-address and sign-in budgets', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
      (getRedisClient as jest.Mock).mockReturnValue({});
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('defaults the authenticated address ceiling and sign-in budget', () => {
      const config = getRateLimitConfig();

      expect(config.authenticatedAddress).toEqual({
        burst: 240,
        sustainedRps: 60,
        sustainedWindowSeconds: 60
      });
      expect(config.signIn).toEqual({
        burst: 10,
        sustainedRps: 1,
        sustainedWindowSeconds: 60
      });
    });

    it('reads both budgets from the environment', () => {
      process.env.API_RATE_LIMIT_AUTH_IP_BURST = '500';
      process.env.API_RATE_LIMIT_AUTH_IP_SUSTAINED_RPS = '100';
      process.env.API_RATE_LIMIT_AUTH_IP_SUSTAINED_WINDOW_SECONDS = '30';
      process.env.API_RATE_LIMIT_SIGN_IN_BURST = '4';
      process.env.API_RATE_LIMIT_SIGN_IN_SUSTAINED_RPS = '2';
      process.env.API_RATE_LIMIT_SIGN_IN_SUSTAINED_WINDOW_SECONDS = '120';

      const config = getRateLimitConfig();

      expect(config.authenticatedAddress).toEqual({
        burst: 500,
        sustainedRps: 100,
        sustainedWindowSeconds: 30
      });
      expect(config.signIn).toEqual({
        burst: 4,
        sustainedRps: 2,
        sustainedWindowSeconds: 120
      });
    });
  });

  describe('rateLimitAddressKey', () => {
    it.each(['192.168.1.1', '10.0.0.255', '1.2.3.4'])(
      'keeps IPv4 address %s whole',
      (ip) => {
        expect(rateLimitAddressKey(ip)).toBe(ip);
      }
    );

    it.each([
      ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
      ['2001:0DB8:0001:0002:0003:0004:0005:0006', '2001:db8:1:2::/64'],
      ['2001:db8::1', '2001:db8:0:0::/64'],
      ['::1', '0:0:0:0::/64'],
      ['::', '0:0:0:0::/64'],
      ['fe80::1%eth0', 'fe80:0:0:0::/64'],
      ['64:ff9b::192.0.2.33', '64:ff9b:0:0::/64'],
      ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64']
    ])('groups IPv6 address %s as %s', (ip, expected) => {
      expect(rateLimitAddressKey(ip)).toBe(expected);
    });

    it('maps every address of a /64 to one key', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: 0xffff }), {
            minLength: 4,
            maxLength: 4
          }),
          (suffix) => {
            const ip = `2001:db8:aa:bb:${suffix.map((g) => g.toString(16)).join(':')}`;
            expect(rateLimitAddressKey(ip)).toBe('2001:db8:aa:bb::/64');
          }
        )
      );
    });

    it('produces a key that survives identifier sanitizing unambiguously', () => {
      expect(
        sanitizeIdentifier(`ip:${rateLimitAddressKey('2001:db8::1')}`)
      ).toBe('ip:2001:db8:0:0::_64');
    });

    it.each([
      ['fe80::1%eth0', 'fe80:0:0:0::/64'],
      ['fe80::abcd%25', 'fe80:0:0:0::/64'],
      ['fe80:0:0:0:1:2:3:4%en0', 'fe80:0:0:0::/64'],
      ['2001:db8:1:2::1%1', '2001:db8:1:2::/64']
    ])('ignores the zone id of %s', (ip, expected) => {
      expect(rateLimitAddressKey(ip)).toBe(expected);
    });

    it.each([
      ['::ffff:1.2.3.4', '1.2.3.4'],
      ['::FFFF:192.168.1.1', '192.168.1.1'],
      ['::ffff:c0a8:101', '192.168.1.1'],
      ['0:0:0:0:0:ffff:7f00:1', '127.0.0.1'],
      ['0000:0000:0000:0000:0000:FFFF:0A00:0001', '10.0.0.1']
    ])('keys IPv4-mapped address %s by its IPv4 address %s', (ip, expected) => {
      expect(rateLimitAddressKey(ip)).toBe(expected);
    });

    it('charges an IPv4-mapped address to the same key as the IPv4 address', () => {
      expect(rateLimitAddressKey('::ffff:203.0.113.9')).toBe(
        rateLimitAddressKey('203.0.113.9')
      );
    });

    it.each([
      ['::', '0:0:0:0::/64'],
      ['::0', '0:0:0:0::/64'],
      ['1::', '1:0:0:0::/64'],
      ['::1:2:3:4:5:6:7', '0:1:2:3::/64'],
      ['1:2:3:4:5:6:7::', '1:2:3:4::/64'],
      ['1:2:3::4:5:6:7', '1:2:3:0::/64'],
      ['0001:0002:0003:0004::', '1:2:3:4::/64'],
      ['ABCD:EF01:2345:6789:ABCD:EF01:2345:6789', 'abcd:ef01:2345:6789::/64'],
      ['::192.0.2.1', '0:0:0:0::/64'],
      ['::ffff:0:1.2.3.4', '0:0:0:0::/64'],
      ['1:2:3:4:5:6:1.2.3.4', '1:2:3:4::/64']
    ])('groups the odd but valid form %s as %s', (ip, expected) => {
      expect(rateLimitAddressKey(ip)).toBe(expected);
    });

    it('gives addresses it cannot parse one shared key, never their own', () => {
      expect(ipv6RateLimitKey('not:an:address::x')).toBe(IPV6_UNPARSED_KEY);
      expect(ipv6RateLimitKey('1::2::3')).toBe(IPV6_UNPARSED_KEY);
      expect(ipv6RateLimitKey('1:2:3:4:5:6:7:8:9')).toBe(IPV6_UNPARSED_KEY);
      expect(ipv6RateLimitKey(':::')).toBe(IPV6_UNPARSED_KEY);
    });

    it('keys every textual form of an address the same as Node’s canonical form', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: 0xffff }), {
            minLength: 8,
            maxLength: 8
          }),
          fc.boolean(),
          (groups, padded) => {
            const full = groups
              .map((g) =>
                padded ? g.toString(16).padStart(4, '0') : g.toString(16)
              )
              .join(':');
            const canonical = new URL(`http://[${full}]/`).hostname.slice(
              1,
              -1
            );
            expect(rateLimitAddressKey(full)).toBe(
              rateLimitAddressKey(canonical)
            );
            expect(rateLimitAddressKey(full)).not.toBe(IPV6_UNPARSED_KEY);
          }
        )
      );
    });
  });

  describe('isSignInRequest', () => {
    it.each([
      ['GET', '/api/auth/nonce'],
      ['GET', '/api/auth/nonce/'],
      ['get', '/api/auth/session-nonce'],
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/session-login']
    ])('matches %s %s', (method, path) => {
      expect(isSignInRequest(method, path)).toBe(true);
    });

    it.each([
      ['POST', '/api/auth/nonce'],
      ['GET', '/api/auth/login'],
      ['POST', '/api/auth/session-refresh'],
      ['POST', '/api/auth/login/extra'],
      ['GET', '/api/auth/nonces'],
      ['GET', '/auth/nonce']
    ])('does not match %s %s', (method, path) => {
      expect(isSignInRequest(method, path)).toBe(false);
    });
  });
});
