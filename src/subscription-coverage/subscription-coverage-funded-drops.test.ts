import {
  forecastSubscriptionCoverage,
  MAX_FUNDED_DROPS_AT_CURRENT_SETTINGS,
  MEMES_MINT_PRICE_WEI
} from './subscription-coverage-forecast';
import { createSubscriptionCoverageFingerprint } from './subscription-coverage-fingerprint';
import {
  SubscriptionCoverageForecastInput,
  SubscriptionCoverageMode,
  SubscriptionCoverageSelection,
  SubscriptionCoverageStatus
} from './subscription-coverage.types';

const NOW_MS = Date.UTC(2026, 10, 22, 12);
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_TOKEN_ID = 578;
const HORIZON = 24;
const LAST_TOKEN_ID = FIRST_TOKEN_ID + HORIZON - 1;

function mints(count: number): bigint {
  return BigInt(count) * MEMES_MINT_PRICE_WEI;
}

function schedule(count = HORIZON) {
  return Array.from({ length: count }, (_, index) => ({
    tokenId: FIRST_TOKEN_ID + index,
    mintAtMs: NOW_MS + (index + 1) * DAY_MS
  }));
}

function selection(
  tokenId: number,
  overrides: Partial<SubscriptionCoverageSelection> = {}
): SubscriptionCoverageSelection {
  return {
    tokenId,
    subscribed: true,
    subscribedCount: 1,
    automaticSubscription: false,
    ...overrides
  };
}

function input(
  overrides: Partial<SubscriptionCoverageForecastInput> = {}
): SubscriptionCoverageForecastInput {
  return {
    consolidationKey: '0xabc',
    calculatedAtMs: NOW_MS,
    hasDemonstratedIntent: true,
    mode: SubscriptionCoverageMode.Automatic,
    subscribeAllEditions: false,
    eligibilityCount: 1,
    balanceWei: BigInt(0),
    mintPriceWei: MEMES_MINT_PRICE_WEI,
    selections: [],
    schedule: schedule(),
    scheduleTruncated: true,
    ...overrides
  };
}

describe('funded drops at current settings', () => {
  it('equals the in-horizon count when fewer than 24 drops are funded', () => {
    const result = forecastSubscriptionCoverage(
      input({ balanceWei: mints(10) })
    );

    expect(result.fullyFundedDrops).toBe(10);
    expect(result.fundedDropsAtCurrentSettings).toEqual({
      count: 10,
      capped: false
    });
  });

  it('reports exactly 24 when the balance funds exactly the forecast', () => {
    const result = forecastSubscriptionCoverage(
      input({ balanceWei: mints(24) })
    );

    expect(result.fullyFundedDrops).toBe(24);
    expect(result.nextUnfunded).toBeNull();
    expect(result.fundedDropsAtCurrentSettings).toEqual({
      count: 24,
      capped: false
    });
  });

  it('keeps counting past the 24-drop forecast', () => {
    const result = forecastSubscriptionCoverage(
      input({ balanceWei: mints(40) })
    );

    expect(result.fullyFundedDrops).toBe(24);
    expect(result.fundedThrough?.tokenId).toBe(LAST_TOKEN_ID);
    expect(result.fundedDropsAtCurrentSettings).toEqual({
      count: 40,
      capped: false
    });
  });

  it('counts only whole drops for a balance that is not a multiple of the price', () => {
    const result = forecastSubscriptionCoverage(
      input({ balanceWei: mints(30) + MEMES_MINT_PRICE_WEI / BigInt(2) })
    );

    expect(result.fundedDropsAtCurrentSettings).toEqual({
      count: 30,
      capped: false
    });
  });

  it('returns null with a zero balance and no demonstrated intent', () => {
    const result = forecastSubscriptionCoverage(
      input({ hasDemonstratedIntent: false })
    );

    expect(result.status).toBe(SubscriptionCoverageStatus.NotSetUp);
    expect(result.fundedDropsAtCurrentSettings ?? null).toBeNull();
  });

  it('reports zero for a set-up profile with a zero balance', () => {
    const result = forecastSubscriptionCoverage(input());

    expect(result.status).toBe(SubscriptionCoverageStatus.ActionRequired);
    expect(result.fundedDropsAtCurrentSettings).toEqual({
      count: 0,
      capped: false
    });
  });

  it('charges every edition per drop when all editions are selected', () => {
    const result = forecastSubscriptionCoverage(
      input({
        subscribeAllEditions: true,
        eligibilityCount: 2,
        balanceWei: mints(2 * 30 + 1)
      })
    );

    expect(result.fullyFundedDrops).toBe(24);
    expect(result.fundedDropsAtCurrentSettings).toEqual({
      count: 30,
      capped: false
    });
  });

  it('honors stored selections after the forecast: opt-outs are skipped and counts are kept', () => {
    const result = forecastSubscriptionCoverage(
      input({
        balanceWei: mints(24 + 4),
        eligibilityCount: 3,
        selections: [
          selection(LAST_TOKEN_ID + 1, { subscribed: false }),
          selection(LAST_TOKEN_ID + 2, { subscribedCount: 3 })
        ]
      })
    );

    // +1 skipped, +2 costs three mints, +3 costs one: four mints fund two drops.
    expect(result.fundedDropsAtCurrentSettings).toEqual({
      count: 26,
      capped: false
    });
  });

  it('stops at the cap and says so', () => {
    const result = forecastSubscriptionCoverage(
      input({ balanceWei: mints(MAX_FUNDED_DROPS_AT_CURRENT_SETTINGS + 50) })
    );

    expect(result.fundedDropsAtCurrentSettings).toEqual({
      count: MAX_FUNDED_DROPS_AT_CURRENT_SETTINGS,
      capped: true
    });
  });

  it('stays at the in-horizon count when an intended drop is unfunded', () => {
    const result = forecastSubscriptionCoverage(
      input({
        balanceWei: mints(40),
        selections: [selection(FIRST_TOKEN_ID + 5, { subscribedCount: 1 })],
        eligibilityCount: 1,
        subscribeAllEditions: false,
        schedule: schedule(),
        mintPriceWei: MEMES_MINT_PRICE_WEI * BigInt(2)
      })
    );

    expect(result.nextUnfunded?.tokenId).toBe(FIRST_TOKEN_ID + 20);
    expect(result.fundedDropsAtCurrentSettings).toEqual({
      count: 20,
      capped: false
    });
  });

  it('does not extend manual mode past the selected drops', () => {
    const result = forecastSubscriptionCoverage(
      input({
        mode: SubscriptionCoverageMode.Manual,
        balanceWei: mints(100),
        selections: [selection(FIRST_TOKEN_ID), selection(FIRST_TOKEN_ID + 3)]
      })
    );

    expect(result.fullyFundedDrops).toBe(2);
    expect(result.fundedDropsAtCurrentSettings).toEqual({
      count: 2,
      capped: false
    });
  });

  it('keeps the new count out of the risk fingerprint', () => {
    const result = forecastSubscriptionCoverage(
      input({ balanceWei: mints(40) })
    );
    const { fingerprint, fundedDropsAtCurrentSettings, ...rest } = result;

    expect(fundedDropsAtCurrentSettings?.count).toBe(40);
    expect(createSubscriptionCoverageFingerprint(rest)).toBe(fingerprint);
  });
});
