import { SubscriptionCoverageStatus } from './subscription-coverage.types';

export const SUBSCRIPTION_COVERAGE_CALCULATION_VERSION = 2;

export const SUBSCRIPTION_COVERAGE_POLICY = Object.freeze({
  coveredMinimumDrops: 7,
  earlyWarningMinimumDrops: 4,
  runningLowMinimumDrops: 2
});

export function statusForConsecutiveFullyFundedDrops(
  fullyFundedDrops: number
): SubscriptionCoverageStatus {
  if (fullyFundedDrops >= SUBSCRIPTION_COVERAGE_POLICY.coveredMinimumDrops) {
    return SubscriptionCoverageStatus.Covered;
  }
  if (
    fullyFundedDrops >= SUBSCRIPTION_COVERAGE_POLICY.earlyWarningMinimumDrops
  ) {
    return SubscriptionCoverageStatus.EarlyWarning;
  }
  if (fullyFundedDrops >= SUBSCRIPTION_COVERAGE_POLICY.runningLowMinimumDrops) {
    return SubscriptionCoverageStatus.RunningLow;
  }
  return SubscriptionCoverageStatus.ActionRequired;
}
