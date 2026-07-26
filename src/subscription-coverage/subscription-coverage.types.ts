export enum SubscriptionCoverageStatus {
  NotSetUp = 'NOT_SET_UP',
  NoCurrentEligibility = 'NO_CURRENT_ELIGIBILITY',
  NoUpcomingSelections = 'NO_UPCOMING_SELECTIONS',
  Covered = 'COVERED',
  EarlyWarning = 'EARLY_WARNING',
  RunningLow = 'RUNNING_LOW',
  ActionRequired = 'ACTION_REQUIRED',
  Unknown = 'UNKNOWN'
}

export enum SubscriptionCoverageMode {
  Automatic = 'AUTOMATIC',
  Manual = 'MANUAL'
}

export enum SubscriptionCoverageIntentSource {
  Automatic = 'AUTOMATIC',
  Manual = 'MANUAL'
}

export enum SubscriptionCoverageEligibilityBasis {
  CurrentEligibility = 'CURRENT_ELIGIBILITY'
}

export enum SubscriptionCoverageScheduleBasis {
  Projected = 'PROJECTED'
}

export enum SubscriptionCoverageDeadlineBasis {
  Unavailable = 'UNAVAILABLE'
}

export enum SubscriptionCoverageUnknownReason {
  InvalidClock = 'INVALID_CLOCK',
  MissingMode = 'MISSING_MODE',
  MissingEligibility = 'MISSING_ELIGIBILITY',
  InvalidEligibility = 'INVALID_ELIGIBILITY',
  InvalidBalance = 'INVALID_BALANCE',
  InvalidMintPrice = 'INVALID_MINT_PRICE',
  InvalidSchedule = 'INVALID_SCHEDULE',
  MissingIntendedSchedule = 'MISSING_INTENDED_SCHEDULE',
  InvalidSubscriptionSelection = 'INVALID_SUBSCRIPTION_SELECTION',
  InsufficientForecastHorizon = 'INSUFFICIENT_FORECAST_HORIZON'
}

export interface SubscriptionCoverageSelection {
  readonly tokenId: number;
  readonly subscribed: boolean;
  readonly subscribedCount: number;
  /**
   * True only for rows created by automatic subscription processing. Production
   * uses current eligibility for these rows when all-editions mode is enabled.
   * A user-authored row keeps its stored count.
   */
  readonly automaticSubscription: boolean;
}

export interface SubscriptionCoverageScheduleEntry {
  readonly tokenId: number;
  readonly mintAtMs: number;
}

export interface SubscriptionCoverageForecastInput {
  readonly consolidationKey: string;
  readonly calculatedAtMs: number;
  readonly hasDemonstratedIntent: boolean;
  readonly mode: SubscriptionCoverageMode | null;
  readonly subscribeAllEditions: boolean;
  readonly eligibilityCount: number | null;
  readonly balanceWei: bigint;
  readonly mintPriceWei: bigint;
  readonly selections: ReadonlyArray<SubscriptionCoverageSelection>;
  readonly schedule: ReadonlyArray<SubscriptionCoverageScheduleEntry>;
  /**
   * True when more future schedule entries exist beyond the supplied schedule.
   * The engine never hides this cap.
   */
  readonly scheduleTruncated: boolean;
}

export interface SubscriptionCoverageMemeReference {
  readonly tokenId: number;
  readonly mintAt: string;
}

export interface SubscriptionCoverageUnfundedDrop extends SubscriptionCoverageMemeReference {
  readonly requestedMints: number;
  readonly fundedMints: number;
  readonly missingMints: number;
  readonly requiredWei: bigint;
  readonly shortfallWei: bigint;
  readonly topUpDeadline: null;
  readonly source: SubscriptionCoverageIntentSource;
}

export interface SubscriptionCoverageMinimumTopUp {
  readonly additionalMints: number;
  readonly amountWei: bigint;
  readonly resultingFullyFundedDrops: number;
  readonly projectedThrough: SubscriptionCoverageMemeReference;
}

export interface SubscriptionCoverageRecommendedTopUp extends SubscriptionCoverageMinimumTopUp {
  readonly targetFullyFundedDrops: number;
}

export interface SubscriptionCoverageForecastHorizon {
  readonly providedScheduleDrops: number;
  readonly intendedDrops: number;
  readonly evaluatedIntendedDrops: number;
  readonly firstTokenId: number | null;
  readonly lastTokenId: number | null;
}

export interface SubscriptionCoverageForecastProvenance {
  readonly eligibilityBasis: SubscriptionCoverageEligibilityBasis;
  readonly scheduleBasis: SubscriptionCoverageScheduleBasis;
  readonly deadlineBasis: SubscriptionCoverageDeadlineBasis;
  readonly forecastTruncated: boolean;
  readonly calculationVersion: number;
  readonly horizon: SubscriptionCoverageForecastHorizon;
}

export interface SubscriptionCoverageForecast {
  readonly consolidationKey: string;
  readonly calculatedAt: string;
  readonly status: SubscriptionCoverageStatus;
  readonly unknownReason: SubscriptionCoverageUnknownReason | null;
  readonly mode: SubscriptionCoverageMode | null;
  readonly subscribeAllEditions: boolean;
  readonly eligibilityCount: number | null;
  readonly balanceWei: bigint;
  readonly mintPriceWei: bigint;
  readonly mintCapacity: number | null;
  readonly allocatedMints: number;
  readonly fullyFundedDrops: number;
  readonly fundedThrough: SubscriptionCoverageMemeReference | null;
  readonly nextUnfunded: SubscriptionCoverageUnfundedDrop | null;
  readonly minimumTopUp: SubscriptionCoverageMinimumTopUp | null;
  readonly recommendedTopUp: SubscriptionCoverageRecommendedTopUp | null;
  readonly forecast: SubscriptionCoverageForecastProvenance;
  /**
   * Stable risk fingerprint. It deliberately excludes calculatedAt so a
   * reconciliation clock tick cannot create a new alert by itself.
   */
  readonly fingerprint: string;
}
