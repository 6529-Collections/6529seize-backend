import { MEMES_MINT_PRICE } from '@/constants';

/**
 * Subscription balances are doubles rounded to five decimals, exactly as the
 * legacy top-up and redemption code rounds them. The identity path keeps this
 * arithmetic so its lists match the legacy lists; changing it is one owner
 * decision (O3) and one change here.
 */
export function roundSubscriptionBalance(value: number): number {
  return Math.round(value * 100000) / 100000;
}

/**
 * Cards a balance pays for, as the legacy list computes it. In doubles some
 * exact multiples floor one short (27 x 0.06529 affords 26), and the legacy
 * lists carry that, so this does too.
 */
export function affordableCardCount(
  balance: number,
  mintPrice: number = MEMES_MINT_PRICE
): number {
  return Math.floor(balance / mintPrice);
}
