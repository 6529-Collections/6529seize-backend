import * as fc from 'fast-check';
import {
  forecastSubscriptionCoverage,
  MEMES_MINT_PRICE_WEI
} from './subscription-coverage-forecast';
import { statusForConsecutiveFullyFundedDrops } from './subscription-coverage-policy';
import {
  SubscriptionCoverageForecastInput,
  SubscriptionCoverageMode,
  SubscriptionCoverageSelection,
  SubscriptionCoverageStatus,
  SubscriptionCoverageUnknownReason
} from './subscription-coverage.types';

const NOW_MS = Date.UTC(2026, 6, 26, 12);
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_TOKEN_ID = 500;
const ZERO_WEI = BigInt(0);
const ONE_WEI = BigInt(1);

function schedule(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    tokenId: FIRST_TOKEN_ID + index,
    mintAtMs: NOW_MS + (index + 1) * DAY_MS
  }));
}

function selection(
  tokenId: number,
  subscribedCount: number,
  overrides: Partial<SubscriptionCoverageSelection> = {}
): SubscriptionCoverageSelection {
  return {
    tokenId,
    subscribed: true,
    subscribedCount,
    automaticSubscription: false,
    ...overrides
  };
}

function input(
  overrides: Partial<SubscriptionCoverageForecastInput> = {}
): SubscriptionCoverageForecastInput {
  return {
    consolidationKey: '0xABC',
    calculatedAtMs: NOW_MS,
    hasDemonstratedIntent: true,
    mode: SubscriptionCoverageMode.Automatic,
    subscribeAllEditions: false,
    eligibilityCount: 1,
    balanceWei: ZERO_WEI,
    mintPriceWei: MEMES_MINT_PRICE_WEI,
    selections: [],
    schedule: schedule(8),
    scheduleTruncated: false,
    ...overrides
  };
}

describe('subscription coverage forecast', () => {
  it.each([
    [7, SubscriptionCoverageStatus.Covered],
    [6, SubscriptionCoverageStatus.EarlyWarning],
    [4, SubscriptionCoverageStatus.EarlyWarning],
    [3, SubscriptionCoverageStatus.RunningLow],
    [2, SubscriptionCoverageStatus.RunningLow],
    [1, SubscriptionCoverageStatus.ActionRequired],
    [0, SubscriptionCoverageStatus.ActionRequired]
  ])(
    'maps %i consecutive fully funded intended drops to %s',
    (fullyFundedDrops, expected) => {
      expect(statusForConsecutiveFullyFundedDrops(fullyFundedDrops)).toBe(
        expected
      );
    }
  );

  it('keeps healthy immediate coverage COVERED when a later drop is unfunded', () => {
    const result = forecastSubscriptionCoverage(
      input({ balanceWei: BigInt(7) * MEMES_MINT_PRICE_WEI })
    );

    expect(result.status).toBe(SubscriptionCoverageStatus.Covered);
    expect(result.fullyFundedDrops).toBe(7);
    expect(result.fundedThrough?.tokenId).toBe(FIRST_TOKEN_ID + 6);
    expect(result.nextUnfunded?.tokenId).toBe(FIRST_TOKEN_ID + 7);
    expect(result.recommendedTopUp).toBeNull();
    expect(result.forecast.calculationVersion).toBe(2);
  });

  it('treats a partially funded immediate xN drop as critical', () => {
    const result = forecastSubscriptionCoverage(
      input({
        mode: SubscriptionCoverageMode.Manual,
        eligibilityCount: 3,
        balanceWei: BigInt(2) * MEMES_MINT_PRICE_WEI,
        selections: [selection(FIRST_TOKEN_ID, 3)]
      })
    );

    expect(result.status).toBe(SubscriptionCoverageStatus.ActionRequired);
    expect(result.mintCapacity).toBe(2);
    expect(result.allocatedMints).toBe(2);
    expect(result.fullyFundedDrops).toBe(0);
    expect(result.fundedThrough).toBeNull();
    expect(result.nextUnfunded).toMatchObject({
      tokenId: FIRST_TOKEN_ID,
      requestedMints: 3,
      fundedMints: 2,
      missingMints: 1,
      shortfallWei: MEMES_MINT_PRICE_WEI,
      topUpDeadline: null
    });
    expect(result.minimumTopUp).toMatchObject({
      additionalMints: 1,
      amountWei: MEMES_MINT_PRICE_WEI,
      resultingFullyFundedDrops: 1
    });
  });

  it.each([
    {
      label: 'one wei below',
      balanceWei: BigInt(3) * MEMES_MINT_PRICE_WEI - ONE_WEI,
      fullyFundedDrops: 0,
      fundedMints: 2,
      shortfallWei: ONE_WEI
    },
    {
      label: 'the exact boundary',
      balanceWei: BigInt(3) * MEMES_MINT_PRICE_WEI,
      fullyFundedDrops: 1,
      fundedMints: null,
      shortfallWei: null
    },
    {
      label: 'one wei above',
      balanceWei: BigInt(3) * MEMES_MINT_PRICE_WEI + ONE_WEI,
      fullyFundedDrops: 1,
      fundedMints: null,
      shortfallWei: null
    }
  ])(
    'allocates an x3 request exactly at $label the funding boundary',
    ({ balanceWei, fullyFundedDrops, fundedMints, shortfallWei }) => {
      const result = forecastSubscriptionCoverage(
        input({
          mode: SubscriptionCoverageMode.Manual,
          eligibilityCount: 3,
          balanceWei,
          selections: [selection(FIRST_TOKEN_ID, 3)]
        })
      );

      expect(result.mintCapacity).toBe(
        Number(balanceWei / MEMES_MINT_PRICE_WEI)
      );
      expect(result.allocatedMints).toBe(
        fullyFundedDrops === 1 ? 3 : fundedMints
      );
      expect(result.fullyFundedDrops).toBe(fullyFundedDrops);
      expect(result.nextUnfunded?.fundedMints ?? null).toBe(fundedMints);
      expect(result.nextUnfunded?.shortfallWei ?? null).toBe(shortfallWei);
    }
  );

  it('separates raw mint capacity from mints allocated to intended drops', () => {
    const result = forecastSubscriptionCoverage(
      input({
        mode: SubscriptionCoverageMode.Manual,
        eligibilityCount: 2,
        balanceWei: BigInt(10) * MEMES_MINT_PRICE_WEI,
        selections: [
          selection(FIRST_TOKEN_ID, 2),
          selection(FIRST_TOKEN_ID + 2, 1)
        ]
      })
    );

    expect(result.mintCapacity).toBe(10);
    expect(result.allocatedMints).toBe(3);
    expect(result.fullyFundedDrops).toBe(2);
  });

  it('uses current all-editions eligibility only for automatic rows', () => {
    const result = forecastSubscriptionCoverage(
      input({
        subscribeAllEditions: true,
        eligibilityCount: 3,
        balanceWei: BigInt(4) * MEMES_MINT_PRICE_WEI,
        selections: [
          selection(FIRST_TOKEN_ID, 1, { automaticSubscription: true }),
          selection(FIRST_TOKEN_ID + 1, 2)
        ]
      })
    );

    expect(result.nextUnfunded).toMatchObject({
      tokenId: FIRST_TOKEN_ID + 1,
      requestedMints: 2,
      fundedMints: 1,
      source: 'MANUAL'
    });
    expect(result.fullyFundedDrops).toBe(1);
    expect(result.allocatedMints).toBe(4);
  });

  it('honors an explicit opt-out before applying automatic intent', () => {
    const result = forecastSubscriptionCoverage(
      input({
        balanceWei: BigInt(7) * MEMES_MINT_PRICE_WEI,
        selections: [
          selection(FIRST_TOKEN_ID, 1, {
            subscribed: false,
            automaticSubscription: true
          })
        ]
      })
    );

    expect(result.status).toBe(SubscriptionCoverageStatus.Covered);
    expect(result.fullyFundedDrops).toBe(7);
    expect(result.fundedThrough?.tokenId).toBe(FIRST_TOKEN_ID + 7);
    expect(result.nextUnfunded).toBeNull();
  });

  it('returns neutral lifecycle states before risk states', () => {
    expect(
      forecastSubscriptionCoverage(input({ hasDemonstratedIntent: false }))
        .status
    ).toBe(SubscriptionCoverageStatus.NotSetUp);
    expect(
      forecastSubscriptionCoverage(input({ eligibilityCount: 0 })).status
    ).toBe(SubscriptionCoverageStatus.NoCurrentEligibility);
    expect(
      forecastSubscriptionCoverage(
        input({
          mode: SubscriptionCoverageMode.Manual,
          selections: []
        })
      ).status
    ).toBe(SubscriptionCoverageStatus.NoUpcomingSelections);
  });

  it('returns UNKNOWN for missing inputs or an insufficient horizon', () => {
    expect(
      forecastSubscriptionCoverage(input({ mode: null })).unknownReason
    ).toBe(SubscriptionCoverageUnknownReason.MissingMode);
    expect(
      forecastSubscriptionCoverage(input({ eligibilityCount: null }))
        .unknownReason
    ).toBe(SubscriptionCoverageUnknownReason.MissingEligibility);
    expect(
      forecastSubscriptionCoverage(
        input({
          schedule: schedule(3),
          scheduleTruncated: true,
          balanceWei: BigInt(3) * MEMES_MINT_PRICE_WEI
        })
      ).unknownReason
    ).toBe(SubscriptionCoverageUnknownReason.InsufficientForecastHorizon);
  });

  it('returns UNKNOWN for a negative stored balance', () => {
    const result = forecastSubscriptionCoverage(
      input({ balanceWei: -BigInt(1) })
    );

    expect(result.status).toBe(SubscriptionCoverageStatus.Unknown);
    expect(result.unknownReason).toBe(
      SubscriptionCoverageUnknownReason.InvalidBalance
    );
    expect(result.minimumTopUp).toBeNull();
    expect(result.recommendedTopUp).toBeNull();
  });

  it('exposes the explicit truncated horizon even when risk is known', () => {
    const result = forecastSubscriptionCoverage(
      input({
        scheduleTruncated: true,
        balanceWei: BigInt(7) * MEMES_MINT_PRICE_WEI
      })
    );

    expect(result.status).toBe(SubscriptionCoverageStatus.Covered);
    expect(result.forecast.forecastTruncated).toBe(true);
    expect(result.forecast.horizon).toMatchObject({
      providedScheduleDrops: 8,
      intendedDrops: 8,
      evaluatedIntendedDrops: 8
    });
  });

  it('requires selected manual token IDs to exist in the supplied schedule', () => {
    const result = forecastSubscriptionCoverage(
      input({
        mode: SubscriptionCoverageMode.Manual,
        selections: [selection(FIRST_TOKEN_ID + 100, 1)]
      })
    );

    expect(result.status).toBe(SubscriptionCoverageStatus.Unknown);
    expect(result.unknownReason).toBe(
      SubscriptionCoverageUnknownReason.MissingIntendedSchedule
    );
  });

  it('uses seven intended drops for the automatic recommended top-up', () => {
    const result = forecastSubscriptionCoverage(
      input({
        subscribeAllEditions: true,
        eligibilityCount: 3
      })
    );

    expect(result.recommendedTopUp).toMatchObject({
      targetFullyFundedDrops: 7,
      additionalMints: 21,
      amountWei: BigInt(21) * MEMES_MINT_PRICE_WEI,
      resultingFullyFundedDrops: 7,
      projectedThrough: { tokenId: FIRST_TOKEN_ID + 6 }
    });
  });

  it('targets every known selection when manual intent has fewer than seven drops', () => {
    const result = forecastSubscriptionCoverage(
      input({
        mode: SubscriptionCoverageMode.Manual,
        eligibilityCount: 2,
        scheduleTruncated: true,
        selections: [
          selection(FIRST_TOKEN_ID, 1),
          selection(FIRST_TOKEN_ID + 2, 2),
          selection(FIRST_TOKEN_ID + 4, 1)
        ]
      })
    );

    expect(result.status).toBe(SubscriptionCoverageStatus.ActionRequired);
    expect(result.recommendedTopUp).toMatchObject({
      targetFullyFundedDrops: 3,
      additionalMints: 4,
      amountWei: BigInt(4) * MEMES_MINT_PRICE_WEI,
      resultingFullyFundedDrops: 3,
      projectedThrough: { tokenId: FIRST_TOKEN_ID + 4 }
    });
  });

  it('returns no recommended top-up when its target is already funded', () => {
    const result = forecastSubscriptionCoverage(
      input({ balanceWei: BigInt(8) * MEMES_MINT_PRICE_WEI })
    );

    expect(result.recommendedTopUp).toBeNull();
  });

  it('is deterministic for a supplied clock and does not fingerprint clock-only changes', () => {
    const first = forecastSubscriptionCoverage(input());
    const same = forecastSubscriptionCoverage(input());
    const later = forecastSubscriptionCoverage(
      input({ calculatedAtMs: NOW_MS + 1 })
    );

    expect(same).toEqual(first);
    expect(later.calculatedAt).not.toBe(first.calculatedAt);
    expect(later.fingerprint).toBe(first.fingerprint);
  });

  it('allocates exactly up to raw capacity across arbitrary manual xN intent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 12 }),
        fc.bigInt({ min: ZERO_WEI, max: MEMES_MINT_PRICE_WEI - ONE_WEI }),
        (capacity, requestedMints, dropCount, remainderWei) => {
          const manualSchedule = schedule(dropCount);
          const result = forecastSubscriptionCoverage(
            input({
              mode: SubscriptionCoverageMode.Manual,
              eligibilityCount: 5,
              balanceWei:
                BigInt(capacity) * MEMES_MINT_PRICE_WEI + remainderWei,
              schedule: manualSchedule,
              selections: manualSchedule.map((drop) =>
                selection(drop.tokenId, requestedMints)
              )
            })
          );

          expect(result.mintCapacity).toBe(capacity);
          expect(result.allocatedMints).toBe(
            Math.min(capacity, requestedMints * dropCount)
          );
          expect(result.fullyFundedDrops).toBe(
            Math.min(dropCount, Math.floor(capacity / requestedMints))
          );
        }
      )
    );
  });

  it('computes the exact minimum top-up needed to fully fund the first gap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }).chain((requestedMints) =>
          fc.tuple(
            fc.constant(requestedMints),
            fc.bigInt({
              min: ZERO_WEI,
              max: BigInt(requestedMints) * MEMES_MINT_PRICE_WEI - ONE_WEI
            })
          )
        ),
        ([requestedMints, balanceWei]) => {
          const forecastInput = input({
            mode: SubscriptionCoverageMode.Manual,
            eligibilityCount: 10,
            balanceWei,
            selections: [selection(FIRST_TOKEN_ID, requestedMints)]
          });
          const result = forecastSubscriptionCoverage(forecastInput);
          const minimum = result.minimumTopUp;

          expect(minimum).not.toBeNull();
          expect(minimum?.amountWei).toBe(
            BigInt(requestedMints) * MEMES_MINT_PRICE_WEI - balanceWei
          );
          expect(minimum?.additionalMints).toBeGreaterThanOrEqual(1);

          const toppedUp = forecastSubscriptionCoverage({
            ...forecastInput,
            balanceWei: balanceWei + (minimum?.amountWei ?? ZERO_WEI)
          });
          expect(toppedUp.fullyFundedDrops).toBe(1);
          expect(toppedUp.nextUnfunded).toBeNull();
        }
      )
    );
  });
});
