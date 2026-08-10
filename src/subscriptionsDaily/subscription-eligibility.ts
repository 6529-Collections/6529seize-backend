export const MINIMUM_SUBSCRIPTION_ELIGIBILITY = 1;

export function normalizeSubscriptionEligibility(memeSets: number): number {
  if (!Number.isSafeInteger(memeSets)) {
    return MINIMUM_SUBSCRIPTION_ELIGIBILITY;
  }
  return Math.max(MINIMUM_SUBSCRIPTION_ELIGIBILITY, memeSets);
}
