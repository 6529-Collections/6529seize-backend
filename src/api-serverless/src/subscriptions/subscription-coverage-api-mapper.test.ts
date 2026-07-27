import { ApiSubscriptionCoverageStatus } from '@/api/generated/models/ApiSubscriptionCoverageStatus';
import { ApiSubscriptionCoverageUnknownReason } from '@/api/generated/models/ApiSubscriptionCoverageUnknownReason';
import {
  exactEthToWei,
  forecastSubscriptionCoverage,
  MEMES_MINT_PRICE_WEI,
  SubscriptionCoverageMode
} from '@/subscription-coverage';
import { mapSubscriptionCoverageToApi } from './subscription-coverage.api-mapper';

const CALCULATED_AT = Date.parse('2026-07-26T21:30:00.000Z');

function schedule(count: number) {
  const firstMintAt = Date.parse('2026-08-03T14:40:00.000Z');
  return Array.from({ length: count }, (_, index) => ({
    tokenId: 528 + index,
    mintAtMs: firstMintAt + index * 2 * 24 * 60 * 60 * 1000
  }));
}

describe('mapSubscriptionCoverageToApi', () => {
  it('maps exact partial-funding values to the generated API contract', () => {
    const forecast = forecastSubscriptionCoverage({
      consolidationKey: '0xABC',
      calculatedAtMs: CALCULATED_AT,
      hasDemonstratedIntent: true,
      mode: SubscriptionCoverageMode.Automatic,
      subscribeAllEditions: true,
      eligibilityCount: 3,
      balanceWei: exactEthToWei('0.13058'),
      mintPriceWei: MEMES_MINT_PRICE_WEI,
      selections: [],
      schedule: schedule(7),
      scheduleTruncated: false
    });

    const result = mapSubscriptionCoverageToApi(forecast);

    expect(result).toMatchObject({
      consolidation_key: '0xabc',
      calculated_at: new Date(CALCULATED_AT),
      status: ApiSubscriptionCoverageStatus.ActionRequired,
      mode: 'AUTOMATIC',
      subscribe_all_editions: true,
      eligibility_count: 3,
      balance_eth: '0.13058',
      mint_price_eth: '0.06529',
      mint_capacity: 2,
      allocated_mints: 2,
      fully_funded_drops: 0,
      funded_through: null,
      next_unfunded: {
        token_id: 528,
        requested_mints: 3,
        funded_mints: 2,
        missing_mints: 1,
        required_eth: '0.19587',
        shortfall_eth: '0.06529',
        top_up_deadline: null,
        source: 'AUTOMATIC'
      },
      minimum_top_up: {
        additional_mints: 1,
        amount_eth: '0.06529',
        resulting_fully_funded_drops: 1
      },
      recommended_top_up: {
        target_fully_funded_drops: 7,
        additional_mints: 19,
        amount_eth: '1.24051'
      },
      forecast: {
        eligibility_basis: 'CURRENT_ELIGIBILITY',
        schedule_basis: 'PROJECTED',
        deadline_basis: 'UNAVAILABLE',
        forecast_truncated: false,
        horizon_start_token_id: 528,
        horizon_end_token_id: 534,
        horizon_drop_count: 7,
        calculation_version: 1,
        unknown_reason: null
      }
    });
    expect(result.forecast.forecast_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('maps missing mode to an explicit unavailable reason', () => {
    const forecast = forecastSubscriptionCoverage({
      consolidationKey: 'key',
      calculatedAtMs: CALCULATED_AT,
      hasDemonstratedIntent: true,
      mode: null,
      subscribeAllEditions: false,
      eligibilityCount: 1,
      balanceWei: exactEthToWei('0.06529'),
      mintPriceWei: MEMES_MINT_PRICE_WEI,
      selections: [],
      schedule: [],
      scheduleTruncated: false
    });

    expect(mapSubscriptionCoverageToApi(forecast)).toMatchObject({
      status: ApiSubscriptionCoverageStatus.Unknown,
      mode: null,
      subscribe_all_editions: null,
      forecast: {
        unknown_reason: ApiSubscriptionCoverageUnknownReason.ModeUnavailable
      }
    });
  });
});
