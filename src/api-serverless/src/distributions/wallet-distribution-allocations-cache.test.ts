import { cacheKey } from '@/api/api-helpers';

describe('wallet distribution allocation cache key', () => {
  it('varies by wallet query parameter', () => {
    const route = '/distributions/0xcontract/534/wallet-allocations?wallet=';

    const walletAKey = cacheKey({
      originalUrl: `${route}0xaaa`
    } as any);
    const walletBKey = cacheKey({
      originalUrl: `${route}0xbbb`
    } as any);

    expect(walletAKey).not.toBe(walletBKey);
  });
});
