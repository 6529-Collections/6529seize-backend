import {
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '@/constants';
import {
  SUBSCRIPTION_KEY_FALLBACK_WIDTH,
  SubscriptionKeyWidths
} from './subscription-key-width';

jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() })
  }
}));

function wallets(count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`
  ).join('-');
}

describe('SubscriptionKeyWidths', () => {
  it('reads widths once per cache period and falls back to 200 for a missing table', async () => {
    let now = 0;
    const load = jest
      .fn()
      .mockResolvedValue(new Map([[SUBSCRIPTIONS_NFTS_TABLE, 666]]));
    const widths = new SubscriptionKeyWidths(load, () => now);
    expect(await widths.widthOf(SUBSCRIPTIONS_NFTS_TABLE)).toBe(666);
    expect(await widths.widthOf(SUBSCRIPTIONS_REDEEMED_TABLE)).toBe(
      SUBSCRIPTION_KEY_FALLBACK_WIDTH
    );
    expect(load).toHaveBeenCalledTimes(1);
    now += 5 * 60 * 1000 + 1;
    await widths.widthOf(SUBSCRIPTIONS_NFTS_TABLE);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('uses 200 after a failed read and retries a minute later', async () => {
    let now = 0;
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error('no catalogue'))
      .mockResolvedValue(new Map([[SUBSCRIPTIONS_NFTS_TABLE, 666]]));
    const widths = new SubscriptionKeyWidths(load, () => now);
    expect(await widths.widthOf(SUBSCRIPTIONS_NFTS_TABLE)).toBe(200);
    now += 60 * 1000 + 1;
    expect(await widths.widthOf(SUBSCRIPTIONS_NFTS_TABLE)).toBe(666);
  });

  it('names the tables too narrow for a key, by wallet count', async () => {
    const widths = new SubscriptionKeyWidths(
      async () =>
        new Map([
          [SUBSCRIPTIONS_NFTS_TABLE, 666],
          [SUBSCRIPTIONS_REDEEMED_TABLE, 567]
        ])
    );
    const tables = [SUBSCRIPTIONS_NFTS_TABLE, SUBSCRIPTIONS_REDEEMED_TABLE];
    expect(await widths.narrowFor(wallets(13), tables)).toEqual([]);
    expect(await widths.narrowFor(wallets(14), tables)).toEqual([
      { table: SUBSCRIPTIONS_REDEEMED_TABLE, width: 567 }
    ]);
    expect(await widths.narrowFor(wallets(16), tables)).toEqual([
      { table: SUBSCRIPTIONS_NFTS_TABLE, width: 666 },
      { table: SUBSCRIPTIONS_REDEEMED_TABLE, width: 567 }
    ]);
    expect(await widths.fits(wallets(4), tables)).toBe(true);
    expect(wallets(14).length).toBe(601);
    expect(wallets(16).length).toBe(687);
  });

  it('reads again after invalidate', async () => {
    const load = jest.fn().mockResolvedValue(new Map());
    const widths = new SubscriptionKeyWidths(load);
    await widths.widthOf(SUBSCRIPTIONS_NFTS_TABLE);
    widths.invalidate();
    await widths.widthOf(SUBSCRIPTIONS_NFTS_TABLE);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
