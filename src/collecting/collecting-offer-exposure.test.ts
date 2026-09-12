import { DbPoolName } from '@/db-query.options';
import { SqlExecutor } from '@/sql-executor';
import { collectOfferExposure } from '@/collecting/collecting-offer-exposure.db';
import { MARKET_WETH } from '@/marketplace/seaport.registry';

describe('offer analysis tracked exposure', () => {
  it('uses primary wallet/currency-scoped liabilities and exact BigInt across profiles and unresolved states', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue([
        { liability_wei: '9007199254740993' },
        { liability_wei: '9007199254740993' }
      ]);
    const db = { execute } as unknown as SqlExecutor;
    expect(await collectOfferExposure('0xABC', db)).toBe(
      BigInt('18014398509481986')
    );
    expect(execute).toHaveBeenCalledWith(
      expect.not.stringMatching(/profile_id|state[ =]/),
      { wallet: '0xabc', currency: MARKET_WETH, zero: '0' },
      { forcePool: DbPoolName.WRITE }
    );
  });
  it('fails closed when tracked liabilities are corrupt or exceed the bounded read', async () => {
    for (const rows of [
      [{ liability_wei: '-1' }],
      Array.from({ length: 10001 }, () => ({ liability_wei: '1' }))
    ]) {
      const db = {
        execute: jest.fn().mockResolvedValue(rows)
      } as unknown as SqlExecutor;
      await expect(collectOfferExposure('wallet', db)).rejects.toMatchObject({
        code: 'OFFER_EXPOSURE_UNAVAILABLE'
      });
    }
  });
});
