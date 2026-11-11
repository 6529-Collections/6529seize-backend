const getRedisClientMock = jest.fn();

jest.mock('@/redis', () => ({
  getRedisClient: () => getRedisClientMock()
}));

import * as fc from 'fast-check';
import {
  clearStructuredWalletSignatureReplayCacheForTests,
  consumeLegacyTextChallengeNonce
} from './structured-wallet-signatures';

const NOW_MS = Date.UTC(2026, 10, 12, 12);

describe('consumeLegacyTextChallengeNonce', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let redisSet: jest.Mock;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    clearStructuredWalletSignatureReplayCacheForTests();
    redisSet = jest.fn().mockResolvedValue('OK');
    getRedisClientMock.mockReturnValue({ set: redisSet });
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('stores the replay entry until the challenge expires, rounded up to a whole second', async () => {
    await expect(
      consumeLegacyTextChallengeNonce('challenge', NOW_MS + 1)
    ).resolves.toBe(true);
    await expect(
      consumeLegacyTextChallengeNonce('other challenge', NOW_MS + 300_000)
    ).resolves.toBe(true);

    expect(redisSet.mock.calls.map(([, , options]) => options)).toEqual([
      { NX: true, EX: 1 },
      { NX: true, EX: 300 }
    ]);
  });

  it('gives every accepted challenge an expiry of at least one second', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 30 * 24 * 3600_000 }),
        async (remainingMs) => {
          redisSet.mockClear();
          await consumeLegacyTextChallengeNonce(
            `challenge ${remainingMs}`,
            NOW_MS + remainingMs
          );
          const [[, , options]] = redisSet.mock.calls;
          expect(Number.isInteger(options.EX)).toBe(true);
          expect(options.EX).toBeGreaterThanOrEqual(1);
          expect(options.EX * 1000).toBeGreaterThanOrEqual(remainingMs);
        }
      )
    );
  });

  it.each([
    ['expired now', NOW_MS],
    ['expired earlier', NOW_MS - 1],
    ['not a number', Number.NaN],
    ['without an end', Number.POSITIVE_INFINITY]
  ])(
    'refuses a challenge whose expiry is %s without writing to Redis',
    async (_label, expiresAtMs) => {
      await expect(
        consumeLegacyTextChallengeNonce('challenge', expiresAtMs)
      ).resolves.toBe(false);
      expect(redisSet).not.toHaveBeenCalled();
    }
  );

  it('refuses an unreadable expiry in the local fallback too', async () => {
    process.env.NODE_ENV = 'test';
    getRedisClientMock.mockReturnValue(null);

    await expect(
      consumeLegacyTextChallengeNonce('challenge', Number.NaN)
    ).resolves.toBe(false);
    await expect(
      consumeLegacyTextChallengeNonce('challenge', NOW_MS + 60_000)
    ).resolves.toBe(true);
    await expect(
      consumeLegacyTextChallengeNonce('challenge', NOW_MS + 60_000)
    ).resolves.toBe(false);
  });
});
