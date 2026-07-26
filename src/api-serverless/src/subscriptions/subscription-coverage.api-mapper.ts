import { ApiSubscriptionCoverage } from '@/api/generated/models/ApiSubscriptionCoverage';
import { ApiSubscriptionCoverageDeadlineBasis } from '@/api/generated/models/ApiSubscriptionCoverageDeadlineBasis';
import { ApiSubscriptionCoverageEligibilityBasis } from '@/api/generated/models/ApiSubscriptionCoverageEligibilityBasis';
import { ApiSubscriptionCoverageMode } from '@/api/generated/models/ApiSubscriptionCoverageMode';
import { ApiSubscriptionCoverageScheduleBasis } from '@/api/generated/models/ApiSubscriptionCoverageScheduleBasis';
import { ApiSubscriptionCoverageSource } from '@/api/generated/models/ApiSubscriptionCoverageSource';
import { ApiSubscriptionCoverageStatus } from '@/api/generated/models/ApiSubscriptionCoverageStatus';
import { ApiSubscriptionCoverageUnknownReason } from '@/api/generated/models/ApiSubscriptionCoverageUnknownReason';
import { enums } from '@/enums';
import {
  SubscriptionCoverageForecast,
  SubscriptionCoverageMinimumTopUp,
  SubscriptionCoverageRecommendedTopUp,
  SubscriptionCoverageUnknownReason,
  weiToExactEth
} from '@/subscription-coverage';

function mapUnknownReason(
  reason: SubscriptionCoverageUnknownReason | null
): ApiSubscriptionCoverageUnknownReason | null {
  switch (reason) {
    case null:
      return null;
    case SubscriptionCoverageUnknownReason.InvalidBalance:
      return ApiSubscriptionCoverageUnknownReason.BalanceInvalid;
    case SubscriptionCoverageUnknownReason.MissingMode:
      return ApiSubscriptionCoverageUnknownReason.ModeUnavailable;
    case SubscriptionCoverageUnknownReason.InvalidSchedule:
    case SubscriptionCoverageUnknownReason.MissingIntendedSchedule:
    case SubscriptionCoverageUnknownReason.InsufficientForecastHorizon:
      return ApiSubscriptionCoverageUnknownReason.ScheduleUnavailable;
    default:
      return ApiSubscriptionCoverageUnknownReason.InputInconsistent;
  }
}

function mapPoint(point: {
  readonly tokenId: number;
  readonly mintAt: string;
}) {
  return {
    token_id: point.tokenId,
    mint_at: new Date(point.mintAt)
  };
}

function mapTopUp(topUp: SubscriptionCoverageMinimumTopUp | null) {
  if (!topUp) {
    return null;
  }
  return {
    additional_mints: topUp.additionalMints,
    amount_eth: weiToExactEth(topUp.amountWei),
    resulting_fully_funded_drops: topUp.resultingFullyFundedDrops,
    projected_through: mapPoint(topUp.projectedThrough)
  };
}

function mapRecommendedTopUp(
  topUp: SubscriptionCoverageRecommendedTopUp | null
) {
  if (!topUp) {
    return null;
  }
  return {
    target_fully_funded_drops: topUp.targetFullyFundedDrops,
    additional_mints: topUp.additionalMints,
    amount_eth: weiToExactEth(topUp.amountWei),
    projected_through: mapPoint(topUp.projectedThrough)
  };
}

export function mapSubscriptionCoverageToApi(
  coverage: SubscriptionCoverageForecast
): ApiSubscriptionCoverage {
  return {
    consolidation_key: coverage.consolidationKey,
    calculated_at: new Date(coverage.calculatedAt),
    status: enums.resolveOrThrow(
      ApiSubscriptionCoverageStatus,
      coverage.status
    ),
    mode: coverage.mode
      ? enums.resolveOrThrow(ApiSubscriptionCoverageMode, coverage.mode)
      : null,
    subscribe_all_editions:
      coverage.mode === null ? null : coverage.subscribeAllEditions,
    eligibility_count: coverage.eligibilityCount,
    balance_eth: weiToExactEth(coverage.balanceWei),
    mint_price_eth: weiToExactEth(coverage.mintPriceWei),
    mint_capacity: coverage.mintCapacity,
    allocated_mints: coverage.allocatedMints,
    fully_funded_drops: coverage.fullyFundedDrops,
    funded_through: coverage.fundedThrough
      ? mapPoint(coverage.fundedThrough)
      : null,
    next_unfunded: coverage.nextUnfunded
      ? {
          token_id: coverage.nextUnfunded.tokenId,
          mint_at: new Date(coverage.nextUnfunded.mintAt),
          requested_mints: coverage.nextUnfunded.requestedMints,
          funded_mints: coverage.nextUnfunded.fundedMints,
          missing_mints: coverage.nextUnfunded.missingMints,
          required_eth: weiToExactEth(coverage.nextUnfunded.requiredWei),
          shortfall_eth: weiToExactEth(coverage.nextUnfunded.shortfallWei),
          top_up_deadline: null,
          source: enums.resolveOrThrow(
            ApiSubscriptionCoverageSource,
            coverage.nextUnfunded.source
          )
        }
      : null,
    minimum_top_up: mapTopUp(coverage.minimumTopUp),
    recommended_top_up: mapRecommendedTopUp(coverage.recommendedTopUp),
    forecast: {
      eligibility_basis: enums.resolveOrThrow(
        ApiSubscriptionCoverageEligibilityBasis,
        coverage.forecast.eligibilityBasis
      ),
      schedule_basis: enums.resolveOrThrow(
        ApiSubscriptionCoverageScheduleBasis,
        coverage.forecast.scheduleBasis
      ),
      deadline_basis: enums.resolveOrThrow(
        ApiSubscriptionCoverageDeadlineBasis,
        coverage.forecast.deadlineBasis
      ),
      forecast_truncated: coverage.forecast.forecastTruncated,
      horizon_start_token_id: coverage.forecast.horizon.firstTokenId,
      horizon_end_token_id: coverage.forecast.horizon.lastTokenId,
      horizon_drop_count: coverage.forecast.horizon.providedScheduleDrops,
      calculation_version: coverage.forecast.calculationVersion,
      forecast_fingerprint: coverage.fingerprint,
      unknown_reason: mapUnknownReason(coverage.unknownReason)
    }
  };
}
