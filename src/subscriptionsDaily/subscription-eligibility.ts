export const MINIMUM_SUBSCRIPTION_ELIGIBILITY = 1;

export function normalizeSubscriptionEligibility(memeSets: unknown): number {
  const parsedMemeSets =
    typeof memeSets === 'number' || typeof memeSets === 'string'
      ? Number(memeSets)
      : Number.NaN;
  if (!Number.isSafeInteger(parsedMemeSets)) {
    return MINIMUM_SUBSCRIPTION_ELIGIBILITY;
  }
  return Math.max(MINIMUM_SUBSCRIPTION_ELIGIBILITY, parsedMemeSets);
}
