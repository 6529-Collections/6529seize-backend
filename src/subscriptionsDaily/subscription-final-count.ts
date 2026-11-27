import { NFTSubscription, SubscriptionMode } from '../entities/ISubscription';

/**
 * The edition count that reaches the final subscription table: the smallest
 * of eligibility, the requested count and what the balance affords, rounded
 * down. Returns null when that is not a positive integer, so a row with a
 * zero, negative or malformed count is left out of the final table.
 */
export function resolveFinalSubscriptionCount(
  eligibilityCount: number,
  requestedCount: number,
  affordableCount: number
): number | null {
  const count = Math.floor(
    Math.min(eligibilityCount, requestedCount, affordableCount)
  );
  return Number.isSafeInteger(count) && count >= 1 ? count : null;
}

export function resolveRequestedSubscriptionCount(
  subscription: Pick<
    NFTSubscription,
    'subscribed_count' | 'automatic_subscription'
  >,
  autoSubscription:
    | Pick<SubscriptionMode, 'subscribe_all_editions'>
    | undefined,
  eligibilityCount: number
): number {
  if (
    autoSubscription?.subscribe_all_editions &&
    subscription.automatic_subscription
  ) {
    return eligibilityCount;
  }

  return subscription.subscribed_count;
}
