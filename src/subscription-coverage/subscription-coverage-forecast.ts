import { ceilingDivide, exactEthToWei } from './subscription-coverage-money';
import {
  statusForConsecutiveFullyFundedDrops,
  SUBSCRIPTION_COVERAGE_CALCULATION_VERSION,
  SUBSCRIPTION_COVERAGE_POLICY
} from './subscription-coverage-policy';
import { createSubscriptionCoverageFingerprint } from './subscription-coverage-fingerprint';
import {
  SubscriptionCoverageDeadlineBasis,
  SubscriptionCoverageEligibilityBasis,
  SubscriptionCoverageForecast,
  SubscriptionCoverageForecastHorizon,
  SubscriptionCoverageForecastInput,
  SubscriptionCoverageIntentSource,
  SubscriptionCoverageMemeReference,
  SubscriptionCoverageMinimumTopUp,
  SubscriptionCoverageMode,
  SubscriptionCoverageRecommendedTopUp,
  SubscriptionCoverageScheduleBasis,
  SubscriptionCoverageScheduleEntry,
  SubscriptionCoverageSelection,
  SubscriptionCoverageStatus,
  SubscriptionCoverageUnfundedDrop,
  SubscriptionCoverageUnknownReason
} from './subscription-coverage.types';

export const MEMES_MINT_PRICE_WEI = exactEthToWei('0.06529');
const ZERO_WEI = BigInt(0);

interface IntendedDrop {
  readonly tokenId: number;
  readonly mintAtMs: number;
  readonly requestedMints: number;
  readonly source: SubscriptionCoverageIntentSource;
}

type IntendedDropsResult =
  | { readonly drops: IntendedDrop[] }
  | { readonly unknownReason: SubscriptionCoverageUnknownReason };

interface AllocationResult {
  readonly allocatedMints: number;
  readonly fullyFundedDrops: number;
  readonly fundedThrough: SubscriptionCoverageMemeReference | null;
  readonly nextUnfunded: SubscriptionCoverageUnfundedDrop | null;
  readonly evaluatedIntendedDrops: number;
}

interface ForecastFields {
  readonly status: SubscriptionCoverageStatus;
  readonly unknownReason: SubscriptionCoverageUnknownReason | null;
  readonly mintCapacity: number | null;
  readonly allocatedMints: number;
  readonly fullyFundedDrops: number;
  readonly fundedThrough: SubscriptionCoverageMemeReference | null;
  readonly nextUnfunded: SubscriptionCoverageUnfundedDrop | null;
  readonly minimumTopUp: SubscriptionCoverageMinimumTopUp | null;
  readonly recommendedTopUp: SubscriptionCoverageRecommendedTopUp | null;
  readonly horizon: SubscriptionCoverageForecastHorizon;
}

function toSafeNumber(value: bigint): number | null {
  if (value < ZERO_WEI || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(value);
}

function isValidCount(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function memeReference(
  drop: Pick<IntendedDrop, 'tokenId' | 'mintAtMs'>
): SubscriptionCoverageMemeReference {
  return {
    tokenId: drop.tokenId,
    mintAt: new Date(drop.mintAtMs).toISOString()
  };
}

function scheduleIsValid(
  schedule: ReadonlyArray<SubscriptionCoverageScheduleEntry>,
  calculatedAtMs: number
): boolean {
  const tokenIds = new Set<number>();
  return schedule.every((entry) => {
    if (
      !Number.isSafeInteger(entry.tokenId) ||
      entry.tokenId <= 0 ||
      !Number.isSafeInteger(entry.mintAtMs) ||
      entry.mintAtMs <= calculatedAtMs ||
      Number.isNaN(new Date(entry.mintAtMs).getTime()) ||
      tokenIds.has(entry.tokenId)
    ) {
      return false;
    }
    tokenIds.add(entry.tokenId);
    return true;
  });
}

function selectionIsValid(selection: SubscriptionCoverageSelection): boolean {
  return (
    Number.isSafeInteger(selection.tokenId) &&
    selection.tokenId > 0 &&
    isValidCount(selection.subscribedCount)
  );
}

function requestedMintsForSelection(
  selection: SubscriptionCoverageSelection,
  mode: SubscriptionCoverageMode,
  subscribeAllEditions: boolean,
  eligibilityCount: number
): {
  readonly requestedMints: number;
  readonly source: SubscriptionCoverageIntentSource;
} {
  if (mode === SubscriptionCoverageMode.Manual) {
    return {
      requestedMints: Math.min(selection.subscribedCount, eligibilityCount),
      source: SubscriptionCoverageIntentSource.Manual
    };
  }

  if (selection.automaticSubscription) {
    const requestedMints = subscribeAllEditions
      ? eligibilityCount
      : Math.min(selection.subscribedCount, eligibilityCount);
    return {
      requestedMints,
      source: SubscriptionCoverageIntentSource.Automatic
    };
  }

  return {
    requestedMints: Math.min(selection.subscribedCount, eligibilityCount),
    source: SubscriptionCoverageIntentSource.Manual
  };
}

function implicitAutomaticRequestedMints(
  subscribeAllEditions: boolean,
  eligibilityCount: number
): number {
  if (subscribeAllEditions) {
    return eligibilityCount;
  }
  return Math.min(1, eligibilityCount);
}

function selectionsByTokenIdOrNull(
  selections: readonly SubscriptionCoverageSelection[]
): Map<number, SubscriptionCoverageSelection> | null {
  if (!selections.every(selectionIsValid)) {
    return null;
  }
  const selectionsByTokenId = new Map<number, SubscriptionCoverageSelection>();
  for (const selection of selections) {
    if (selectionsByTokenId.has(selection.tokenId)) {
      return null;
    }
    selectionsByTokenId.set(selection.tokenId, selection);
  }
  return selectionsByTokenId;
}

function hasManualSelectionWithoutSchedule(
  mode: SubscriptionCoverageMode,
  selections: readonly SubscriptionCoverageSelection[],
  scheduleTokenIds: ReadonlySet<number>
): boolean {
  return (
    mode === SubscriptionCoverageMode.Manual &&
    selections.some(
      (selection) =>
        selection.subscribed && !scheduleTokenIds.has(selection.tokenId)
    )
  );
}

function intendedDropForSchedule(
  schedule: SubscriptionCoverageScheduleEntry,
  selection: SubscriptionCoverageSelection | undefined,
  mode: SubscriptionCoverageMode,
  subscribeAllEditions: boolean,
  eligibilityCount: number
): IntendedDrop | null {
  if (selection && !selection.subscribed) {
    return null;
  }
  if (mode === SubscriptionCoverageMode.Manual && !selection) {
    return null;
  }
  if (selection) {
    return {
      ...schedule,
      ...requestedMintsForSelection(
        selection,
        mode,
        subscribeAllEditions,
        eligibilityCount
      )
    };
  }
  return {
    ...schedule,
    requestedMints: implicitAutomaticRequestedMints(
      subscribeAllEditions,
      eligibilityCount
    ),
    source: SubscriptionCoverageIntentSource.Automatic
  };
}

function sortedSchedule(
  input: SubscriptionCoverageForecastInput
): SubscriptionCoverageScheduleEntry[] {
  return [...input.schedule].sort(
    (left, right) =>
      left.mintAtMs - right.mintAtMs || left.tokenId - right.tokenId
  );
}

function buildIntendedDrops(
  input: SubscriptionCoverageForecastInput,
  eligibilityCount: number
): IntendedDropsResult {
  const mode = input.mode;
  if (mode === null) {
    return { unknownReason: SubscriptionCoverageUnknownReason.MissingMode };
  }
  const selectionsByTokenId = selectionsByTokenIdOrNull(input.selections);
  if (!selectionsByTokenId) {
    return invalidSubscriptionSelection();
  }

  const orderedSchedule = sortedSchedule(input);
  const scheduleTokenIds = new Set(
    orderedSchedule.map((schedule) => schedule.tokenId)
  );

  if (
    hasManualSelectionWithoutSchedule(mode, input.selections, scheduleTokenIds)
  ) {
    return {
      unknownReason: SubscriptionCoverageUnknownReason.MissingIntendedSchedule
    };
  }

  const drops: IntendedDrop[] = [];
  for (const schedule of orderedSchedule) {
    const selection = selectionsByTokenId.get(schedule.tokenId);
    const drop = intendedDropForSchedule(
      schedule,
      selection,
      mode,
      input.subscribeAllEditions,
      eligibilityCount
    );
    if (drop) {
      drops.push(drop);
    }
  }

  if (!drops.every((drop) => isValidCount(drop.requestedMints))) {
    return invalidSubscriptionSelection();
  }

  return { drops };
}

function invalidSubscriptionSelection(): IntendedDropsResult {
  return {
    unknownReason:
      SubscriptionCoverageUnknownReason.InvalidSubscriptionSelection
  };
}

function allocate(
  drops: ReadonlyArray<IntendedDrop>,
  balanceWei: bigint,
  mintPriceWei: bigint
): AllocationResult {
  let remainingWei = balanceWei;
  let allocatedMints = 0;
  let fullyFundedDrops = 0;
  let fundedThrough: SubscriptionCoverageMemeReference | null = null;
  let evaluatedIntendedDrops = 0;

  for (const drop of drops) {
    evaluatedIntendedDrops++;
    const requestedWei = BigInt(drop.requestedMints) * mintPriceWei;
    const affordableMints =
      remainingWei <= ZERO_WEI ? ZERO_WEI : remainingWei / mintPriceWei;
    const fundedMints = Math.min(
      drop.requestedMints,
      toSafeNumber(affordableMints) ?? drop.requestedMints
    );
    allocatedMints += fundedMints;

    if (remainingWei >= requestedWei) {
      fullyFundedDrops++;
      remainingWei -= requestedWei;
      fundedThrough = memeReference(drop);
      continue;
    }

    return {
      allocatedMints,
      fullyFundedDrops,
      fundedThrough,
      nextUnfunded: {
        ...memeReference(drop),
        requestedMints: drop.requestedMints,
        fundedMints,
        missingMints: drop.requestedMints - fundedMints,
        requiredWei: requestedWei,
        shortfallWei: requestedWei - remainingWei,
        topUpDeadline: null,
        source: drop.source
      },
      evaluatedIntendedDrops
    };
  }

  return {
    allocatedMints,
    fullyFundedDrops,
    fundedThrough,
    nextUnfunded: null,
    evaluatedIntendedDrops
  };
}

function minimumTopUpFor(
  allocation: AllocationResult
): SubscriptionCoverageMinimumTopUp | null {
  if (!allocation.nextUnfunded) {
    return null;
  }
  const additionalMints = toSafeNumber(
    ceilingDivide(
      allocation.nextUnfunded.shortfallWei,
      allocation.nextUnfunded.requiredWei /
        BigInt(allocation.nextUnfunded.requestedMints)
    )
  );
  if (additionalMints === null || additionalMints < 1) {
    return null;
  }
  return {
    additionalMints,
    amountWei: allocation.nextUnfunded.shortfallWei,
    resultingFullyFundedDrops: allocation.fullyFundedDrops + 1,
    projectedThrough: {
      tokenId: allocation.nextUnfunded.tokenId,
      mintAt: allocation.nextUnfunded.mintAt
    }
  };
}

function recommendedTopUpFor(
  input: SubscriptionCoverageForecastInput,
  drops: ReadonlyArray<IntendedDrop>
): SubscriptionCoverageRecommendedTopUp | null {
  if (drops.length === 0) {
    return null;
  }

  const targetDropCount = Math.min(
    SUBSCRIPTION_COVERAGE_POLICY.coveredMinimumDrops,
    drops.length
  );
  if (
    input.mode === SubscriptionCoverageMode.Automatic &&
    targetDropCount < SUBSCRIPTION_COVERAGE_POLICY.coveredMinimumDrops &&
    input.scheduleTruncated
  ) {
    return null;
  }

  const targetDrops = drops.slice(0, targetDropCount);
  const targetCostWei = targetDrops.reduce(
    (total, drop) => total + BigInt(drop.requestedMints) * input.mintPriceWei,
    ZERO_WEI
  );
  const amountWei =
    targetCostWei > input.balanceWei
      ? targetCostWei - input.balanceWei
      : ZERO_WEI;
  if (amountWei === ZERO_WEI) {
    return null;
  }
  const additionalMints = toSafeNumber(
    ceilingDivide(amountWei, input.mintPriceWei)
  );
  if (additionalMints === null || additionalMints < 1) {
    return null;
  }

  return {
    targetFullyFundedDrops: targetDropCount,
    additionalMints,
    amountWei,
    resultingFullyFundedDrops: targetDropCount,
    projectedThrough: memeReference(targetDrops[targetDrops.length - 1])
  };
}

function buildHorizon(
  input: SubscriptionCoverageForecastInput,
  intendedDrops: ReadonlyArray<IntendedDrop>,
  evaluatedIntendedDrops: number
): SubscriptionCoverageForecastHorizon {
  const orderedSchedule = sortedSchedule(input);
  return {
    providedScheduleDrops: orderedSchedule.length,
    intendedDrops: intendedDrops.length,
    evaluatedIntendedDrops,
    firstTokenId: orderedSchedule[0]?.tokenId ?? null,
    lastTokenId: orderedSchedule[orderedSchedule.length - 1]?.tokenId ?? null
  };
}

function baseHorizon(
  input: SubscriptionCoverageForecastInput
): SubscriptionCoverageForecastHorizon {
  return buildHorizon(input, [], 0);
}

function assembleForecast(
  input: SubscriptionCoverageForecastInput,
  calculatedAt: string,
  fields: ForecastFields
): SubscriptionCoverageForecast {
  const withoutFingerprint: Omit<SubscriptionCoverageForecast, 'fingerprint'> =
    {
      consolidationKey: input.consolidationKey.toLowerCase(),
      calculatedAt,
      status: fields.status,
      unknownReason: fields.unknownReason,
      mode: input.mode,
      subscribeAllEditions: input.subscribeAllEditions,
      eligibilityCount: input.eligibilityCount,
      balanceWei: input.balanceWei,
      mintPriceWei: input.mintPriceWei,
      mintCapacity: fields.mintCapacity,
      allocatedMints: fields.allocatedMints,
      fullyFundedDrops: fields.fullyFundedDrops,
      fundedThrough: fields.fundedThrough,
      nextUnfunded: fields.nextUnfunded,
      minimumTopUp: fields.minimumTopUp,
      recommendedTopUp: fields.recommendedTopUp,
      forecast: {
        eligibilityBasis:
          SubscriptionCoverageEligibilityBasis.CurrentEligibility,
        scheduleBasis: SubscriptionCoverageScheduleBasis.Projected,
        deadlineBasis: SubscriptionCoverageDeadlineBasis.Unavailable,
        forecastTruncated: input.scheduleTruncated,
        calculationVersion: SUBSCRIPTION_COVERAGE_CALCULATION_VERSION,
        horizon: fields.horizon
      }
    };

  return {
    ...withoutFingerprint,
    fingerprint: createSubscriptionCoverageFingerprint(withoutFingerprint)
  };
}

function unknownForecast(
  input: SubscriptionCoverageForecastInput,
  calculatedAt: string,
  reason: SubscriptionCoverageUnknownReason,
  mintCapacity: number | null = null
): SubscriptionCoverageForecast {
  return assembleForecast(input, calculatedAt, {
    status: SubscriptionCoverageStatus.Unknown,
    unknownReason: reason,
    mintCapacity,
    allocatedMints: 0,
    fullyFundedDrops: 0,
    fundedThrough: null,
    nextUnfunded: null,
    minimumTopUp: null,
    recommendedTopUp: null,
    horizon: baseHorizon(input)
  });
}

interface ValidatedForecastInput {
  readonly valid: true;
  readonly calculatedAt: string;
  readonly mintCapacity: number;
  readonly eligibilityCount: number;
}

interface TerminalForecastInput {
  readonly valid: false;
  readonly forecast: SubscriptionCoverageForecast;
}

function notSetUpMintCapacity(
  input: SubscriptionCoverageForecastInput
): number | null {
  if (input.mintPriceWei <= ZERO_WEI) {
    return null;
  }
  const nonNegativeBalance =
    input.balanceWei > ZERO_WEI ? input.balanceWei : ZERO_WEI;
  return toSafeNumber(nonNegativeBalance / input.mintPriceWei);
}

function validateForecastInput(
  input: SubscriptionCoverageForecastInput
): ValidatedForecastInput | TerminalForecastInput {
  if (
    !Number.isSafeInteger(input.calculatedAtMs) ||
    Number.isNaN(new Date(input.calculatedAtMs).getTime())
  ) {
    return {
      valid: false,
      forecast: unknownForecast(
        input,
        new Date(0).toISOString(),
        SubscriptionCoverageUnknownReason.InvalidClock
      )
    };
  }
  const calculatedAt = new Date(input.calculatedAtMs).toISOString();
  if (!input.hasDemonstratedIntent) {
    return {
      valid: false,
      forecast: assembleForecast(input, calculatedAt, {
        status: SubscriptionCoverageStatus.NotSetUp,
        unknownReason: null,
        mintCapacity: notSetUpMintCapacity(input),
        allocatedMints: 0,
        fullyFundedDrops: 0,
        fundedThrough: null,
        nextUnfunded: null,
        minimumTopUp: null,
        recommendedTopUp: null,
        horizon: baseHorizon(input)
      })
    };
  }
  if (input.mintPriceWei <= ZERO_WEI) {
    return {
      valid: false,
      forecast: unknownForecast(
        input,
        calculatedAt,
        SubscriptionCoverageUnknownReason.InvalidMintPrice
      )
    };
  }
  if (input.balanceValid === false) {
    return {
      valid: false,
      forecast: unknownForecast(
        input,
        calculatedAt,
        SubscriptionCoverageUnknownReason.InvalidBalance
      )
    };
  }
  if (input.balanceWei < ZERO_WEI) {
    return {
      valid: false,
      forecast: unknownForecast(
        input,
        calculatedAt,
        SubscriptionCoverageUnknownReason.InvalidBalance
      )
    };
  }
  const mintCapacity = toSafeNumber(input.balanceWei / input.mintPriceWei);
  if (mintCapacity === null) {
    return {
      valid: false,
      forecast: unknownForecast(
        input,
        calculatedAt,
        SubscriptionCoverageUnknownReason.InvalidBalance
      )
    };
  }
  if (input.mode === null) {
    return {
      valid: false,
      forecast: unknownForecast(
        input,
        calculatedAt,
        SubscriptionCoverageUnknownReason.MissingMode,
        mintCapacity
      )
    };
  }
  if (input.eligibilityCount === null) {
    return {
      valid: false,
      forecast: unknownForecast(
        input,
        calculatedAt,
        SubscriptionCoverageUnknownReason.MissingEligibility,
        mintCapacity
      )
    };
  }
  if (
    !Number.isSafeInteger(input.eligibilityCount) ||
    input.eligibilityCount < 0
  ) {
    return {
      valid: false,
      forecast: unknownForecast(
        input,
        calculatedAt,
        SubscriptionCoverageUnknownReason.InvalidEligibility,
        mintCapacity
      )
    };
  }
  if (input.eligibilityCount === 0) {
    return {
      valid: false,
      forecast: assembleForecast(input, calculatedAt, {
        status: SubscriptionCoverageStatus.NoCurrentEligibility,
        unknownReason: null,
        mintCapacity,
        allocatedMints: 0,
        fullyFundedDrops: 0,
        fundedThrough: null,
        nextUnfunded: null,
        minimumTopUp: null,
        recommendedTopUp: null,
        horizon: baseHorizon(input)
      })
    };
  }
  return {
    valid: true,
    calculatedAt,
    mintCapacity,
    eligibilityCount: input.eligibilityCount
  };
}

export function forecastSubscriptionCoverage(
  input: SubscriptionCoverageForecastInput
): SubscriptionCoverageForecast {
  const validation = validateForecastInput(input);
  if (!validation.valid) {
    return validation.forecast;
  }
  const { calculatedAt, mintCapacity, eligibilityCount } = validation;

  if (!scheduleIsValid(input.schedule, input.calculatedAtMs)) {
    return unknownForecast(
      input,
      calculatedAt,
      SubscriptionCoverageUnknownReason.InvalidSchedule,
      mintCapacity
    );
  }

  if (
    input.mode === SubscriptionCoverageMode.Manual &&
    !input.selections.some((selection) => selection.subscribed)
  ) {
    return assembleForecast(input, calculatedAt, {
      status: SubscriptionCoverageStatus.NoUpcomingSelections,
      unknownReason: null,
      mintCapacity,
      allocatedMints: 0,
      fullyFundedDrops: 0,
      fundedThrough: null,
      nextUnfunded: null,
      minimumTopUp: null,
      recommendedTopUp: null,
      horizon: baseHorizon(input)
    });
  }

  const intendedResult = buildIntendedDrops(input, eligibilityCount);
  if ('unknownReason' in intendedResult) {
    return unknownForecast(
      input,
      calculatedAt,
      intendedResult.unknownReason,
      mintCapacity
    );
  }
  const intendedDrops = intendedResult.drops;

  if (intendedDrops.length === 0) {
    if (input.scheduleTruncated) {
      return unknownForecast(
        input,
        calculatedAt,
        SubscriptionCoverageUnknownReason.InsufficientForecastHorizon,
        mintCapacity
      );
    }
    return assembleForecast(input, calculatedAt, {
      status: SubscriptionCoverageStatus.NoUpcomingSelections,
      unknownReason: null,
      mintCapacity,
      allocatedMints: 0,
      fullyFundedDrops: 0,
      fundedThrough: null,
      nextUnfunded: null,
      minimumTopUp: null,
      recommendedTopUp: null,
      horizon: buildHorizon(input, intendedDrops, 0)
    });
  }

  const allocation = allocate(
    intendedDrops,
    input.balanceWei,
    input.mintPriceWei
  );

  if (
    input.mode === SubscriptionCoverageMode.Automatic &&
    input.scheduleTruncated &&
    allocation.nextUnfunded === null &&
    allocation.fullyFundedDrops <
      SUBSCRIPTION_COVERAGE_POLICY.coveredMinimumDrops
  ) {
    return unknownForecast(
      input,
      calculatedAt,
      SubscriptionCoverageUnknownReason.InsufficientForecastHorizon,
      mintCapacity
    );
  }

  const status = statusForConsecutiveFullyFundedDrops(
    allocation.fullyFundedDrops
  );
  return assembleForecast(input, calculatedAt, {
    status,
    unknownReason: null,
    mintCapacity,
    allocatedMints: allocation.allocatedMints,
    fullyFundedDrops: allocation.fullyFundedDrops,
    fundedThrough: allocation.fundedThrough,
    nextUnfunded: allocation.nextUnfunded,
    minimumTopUp: minimumTopUpFor(allocation),
    recommendedTopUp: recommendedTopUpFor(input, intendedDrops),
    horizon: buildHorizon(
      input,
      intendedDrops,
      allocation.evaluatedIntendedDrops
    )
  });
}
