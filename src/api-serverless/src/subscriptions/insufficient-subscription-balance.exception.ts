import { MEMES_MINT_PRICE } from '@/constants';
import { BadRequestException } from '@/exceptions';

/**
 * Raised when automatic subscription mode is requested for a balance below
 * the mint price. Responds with 400 like any other bad request.
 */
export class InsufficientSubscriptionBalanceException extends BadRequestException {
  constructor() {
    super(
      `Not enough balance to set Subscription to Automatic. Need at least ${MEMES_MINT_PRICE} ETH.`
    );
  }
}

export function hasMinimumBalanceForAutomaticMode(
  balance: number | string | null | undefined
): boolean {
  if (balance === null || balance === undefined || balance === '') {
    return false;
  }
  const numeric = Number(balance);
  return Number.isFinite(numeric) && numeric >= MEMES_MINT_PRICE;
}
