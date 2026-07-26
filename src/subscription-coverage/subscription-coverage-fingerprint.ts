import { createHash } from 'crypto';
import { SubscriptionCoverageForecast } from './subscription-coverage.types';

/**
 * Fingerprints material coverage risk. `calculatedAt` and generic horizon
 * metadata are intentionally excluded so clock-only reconciliation and a
 * larger-but-equivalent scan do not generate a new lifecycle notification.
 */
export function createSubscriptionCoverageFingerprint(
  forecast: Omit<SubscriptionCoverageForecast, 'fingerprint'>
): string {
  const payload = {
    calculationVersion: forecast.forecast.calculationVersion,
    consolidationKey: forecast.consolidationKey.toLowerCase(),
    status: forecast.status,
    unknownReason: forecast.unknownReason,
    mode: forecast.mode,
    subscribeAllEditions: forecast.subscribeAllEditions,
    eligibilityCount: forecast.eligibilityCount,
    balanceWei: forecast.balanceWei.toString(),
    mintPriceWei: forecast.mintPriceWei.toString(),
    mintCapacity: forecast.mintCapacity,
    allocatedMints: forecast.allocatedMints,
    fullyFundedDrops: forecast.fullyFundedDrops,
    fundedThrough: forecast.fundedThrough,
    nextUnfunded:
      forecast.nextUnfunded === null
        ? null
        : {
            ...forecast.nextUnfunded,
            requiredWei: forecast.nextUnfunded.requiredWei.toString(),
            shortfallWei: forecast.nextUnfunded.shortfallWei.toString()
          },
    minimumTopUp:
      forecast.minimumTopUp === null
        ? null
        : {
            ...forecast.minimumTopUp,
            amountWei: forecast.minimumTopUp.amountWei.toString()
          },
    recommendedTopUp:
      forecast.recommendedTopUp === null
        ? null
        : {
            ...forecast.recommendedTopUp,
            amountWei: forecast.recommendedTopUp.amountWei.toString()
          },
    forecastTruncated: forecast.forecast.forecastTruncated
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
