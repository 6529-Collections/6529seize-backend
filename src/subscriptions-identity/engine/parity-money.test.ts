import fc from 'fast-check';
import { MEMES_MINT_PRICE } from '@/constants';
import { affordableCardCount, roundSubscriptionBalance } from './parity-money';

describe('parity money', () => {
  it('rounds to five decimals as the legacy loops do', () => {
    expect(roundSubscriptionBalance(0.130580000001)).toBe(0.13058);
    expect(roundSubscriptionBalance(0.5 - MEMES_MINT_PRICE)).toBe(0.43471);
  });

  it('keeps the legacy floor at exact multiples that undercount', () => {
    const balance = roundSubscriptionBalance(27 * MEMES_MINT_PRICE);
    expect(affordableCardCount(balance)).toBe(26);
    expect(affordableCardCount(roundSubscriptionBalance(2 * MEMES_MINT_PRICE))).toBe(
      2
    );
  });

  it('never affords more than the balance pays for', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (units) => {
        const balance = units / 100000;
        const count = affordableCardCount(balance);
        expect(count * MEMES_MINT_PRICE).toBeLessThanOrEqual(balance + 1e-9);
      })
    );
  });
});
