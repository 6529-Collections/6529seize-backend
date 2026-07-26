import { Logger } from '@/logging';
import { SubscriptionCoverageNotificationData } from '@/notifications/user-notification.types';
import { RequestContext } from '@/request.context';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import {
  exactEthToWei,
  forecastSubscriptionCoverage,
  MEMES_MINT_PRICE_WEI,
  SubscriptionCoverageForecast,
  SubscriptionCoverageMode,
  SubscriptionCoverageStatus,
  weiToExactEth
} from '@/subscription-coverage';
import {
  decideSubscriptionCoverageAlert,
  StoredSubscriptionCoverageAlertState,
  SubscriptionCoverageAlertPolicy,
  SubscriptionCoverageAlertStatus
} from './subscription-coverage-alert-policy';
import {
  memeCalendarScheduleProvider,
  MemeCalendarScheduleProvider,
  SubscriptionCoverageSchedule
} from './meme-calendar-schedule.provider';
import {
  CanonicalSubscriptionCoverageProfile,
  subscriptionCoverageRepository,
  SubscriptionCoverageNotificationSnapshot,
  SubscriptionCoverageRepository,
  SubscriptionCoverageSourceData
} from './subscription-coverage.repository';

export type SubscriptionCoverageReconciliationMode = 'DIRTY' | 'FULL';

export interface SubscriptionCoverageReconciliationOptions {
  readonly dryRun: boolean;
  readonly notificationsEnabled: boolean;
  readonly baselineOnly: boolean;
  readonly notifyInitialCritical: boolean;
  readonly pushEnabled: boolean;
}

export interface SubscriptionCoverageReconciliationResult {
  readonly mode: SubscriptionCoverageReconciliationMode;
  readonly scanned: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly baselined: number;
  readonly notificationsCreated: number;
  readonly pushesQueued: number;
  readonly wouldNotify: number;
  readonly deduplicatedOrSuppressed: number;
  readonly unroutable: number;
  readonly statusCounts: Record<string, number>;
  readonly hasMore: boolean;
  readonly lastConsolidationKey: string | null;
}

interface ReconciledCoverage {
  readonly source: SubscriptionCoverageSourceData;
  readonly profile: CanonicalSubscriptionCoverageProfile | null;
  readonly forecast: SubscriptionCoverageForecast;
}

interface BatchCounters {
  succeeded: number;
  failed: number;
  baselined: number;
  notificationsCreated: number;
  pushesQueued: number;
  wouldNotify: number;
  deduplicatedOrSuppressed: number;
  unroutable: number;
  statusCounts: Record<string, number>;
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function isPushStatus(status: SubscriptionCoverageStatus): boolean {
  return (
    status === SubscriptionCoverageStatus.RunningLow ||
    status === SubscriptionCoverageStatus.ActionRequired
  );
}

function alertPolicy(
  options: SubscriptionCoverageReconciliationOptions
): SubscriptionCoverageAlertPolicy {
  return {
    notificationsEnabled: options.notificationsEnabled,
    baselineOnly: options.baselineOnly,
    notifyInitialCritical: options.notifyInitialCritical
  };
}

function createNotificationData(
  forecast: SubscriptionCoverageForecast,
  profile: CanonicalSubscriptionCoverageProfile | null
): SubscriptionCoverageNotificationData | null {
  if (!profile) {
    return null;
  }
  const warningStatus =
    forecast.status === SubscriptionCoverageStatus.EarlyWarning ||
    forecast.status === SubscriptionCoverageStatus.RunningLow ||
    forecast.status === SubscriptionCoverageStatus.ActionRequired;
  if (!warningStatus) {
    return null;
  }
  return {
    recipient_profile_id: profile.profileId,
    profile_handle: profile.handle,
    status: forecast.status,
    consolidation_key: forecast.consolidationKey,
    mint_capacity: forecast.mintCapacity ?? 0,
    allocated_mints: forecast.allocatedMints,
    fully_funded_drops: forecast.fullyFundedDrops,
    funded_through: forecast.fundedThrough
      ? {
          token_id: forecast.fundedThrough.tokenId,
          mint_at: forecast.fundedThrough.mintAt
        }
      : null,
    next_unfunded: forecast.nextUnfunded
      ? {
          token_id: forecast.nextUnfunded.tokenId,
          mint_at: forecast.nextUnfunded.mintAt,
          requested_mints: forecast.nextUnfunded.requestedMints,
          funded_mints: forecast.nextUnfunded.fundedMints,
          missing_mints: forecast.nextUnfunded.missingMints
        }
      : null,
    minimum_top_up_eth: forecast.minimumTopUp
      ? weiToExactEth(forecast.minimumTopUp.amountWei)
      : null,
    top_up_deadline: null,
    calculation_version: forecast.forecast.calculationVersion,
    forecast_fingerprint: forecast.fingerprint
  };
}

function toForecast(
  source: SubscriptionCoverageSourceData,
  schedule: SubscriptionCoverageSchedule,
  calculatedAtMs: number
): SubscriptionCoverageForecast {
  return forecastSubscriptionCoverage({
    consolidationKey: source.consolidationKey,
    calculatedAtMs,
    hasDemonstratedIntent: source.hasDemonstratedIntent,
    mode:
      source.mode === null
        ? null
        : source.mode.automatic
          ? SubscriptionCoverageMode.Automatic
          : SubscriptionCoverageMode.Manual,
    subscribeAllEditions: source.mode?.subscribeAllEditions ?? false,
    eligibilityCount: source.eligibilityCount,
    balanceWei: exactEthToWei(source.balanceEth),
    mintPriceWei: MEMES_MINT_PRICE_WEI,
    selections: source.selections,
    schedule: schedule.drops.map((drop) => ({
      tokenId: drop.tokenId,
      mintAtMs: Date.parse(drop.mintAt)
    })),
    scheduleTruncated: schedule.truncated
  });
}

function emptyCounters(): BatchCounters {
  return {
    succeeded: 0,
    failed: 0,
    baselined: 0,
    notificationsCreated: 0,
    pushesQueued: 0,
    wouldNotify: 0,
    deduplicatedOrSuppressed: 0,
    unroutable: 0,
    statusCounts: {}
  };
}

function materiallyMatchesStoredState(
  state: StoredSubscriptionCoverageAlertState,
  snapshot: SubscriptionCoverageNotificationSnapshot
): boolean {
  return (
    state.current_status === snapshot.status &&
    state.current_at_risk_token_id === snapshot.atRiskTokenId &&
    state.current_fully_funded_drops === snapshot.fullyFundedDrops &&
    state.current_requested_mints === snapshot.requestedMints &&
    state.current_missing_mints === snapshot.missingMints &&
    state.recipient_profile_id === snapshot.recipientProfileId
  );
}

export class SubscriptionCoverageReconciliationService {
  private readonly logger = Logger.get(
    SubscriptionCoverageReconciliationService.name
  );

  constructor(
    private readonly repository: SubscriptionCoverageRepository = subscriptionCoverageRepository,
    private readonly scheduleProvider: MemeCalendarScheduleProvider = memeCalendarScheduleProvider,
    private readonly now: () => number = Date.now
  ) {}

  public async calculateCoverage(
    consolidationKey: string,
    ctx: RequestContext = {}
  ): Promise<SubscriptionCoverageForecast> {
    const normalizedKey = consolidationKey.trim().toLowerCase();
    let schedule: SubscriptionCoverageSchedule;
    try {
      schedule = await this.scheduleProvider.getSchedule();
    } catch (error) {
      this.logger.warn(
        'Projected Meme schedule unavailable for subscription coverage read',
        { error }
      );
      schedule = {
        drops: [],
        basis: 'PROJECTED',
        deadlineBasis: 'UNAVAILABLE',
        horizon: 0,
        truncated: true,
        fetchedAt: new Date(this.now()).toISOString()
      };
    }
    const forecasts = await this.calculateCoverageBatch(
      [normalizedKey],
      schedule,
      ctx
    );
    const forecast = forecasts.get(normalizedKey)?.forecast;
    if (!forecast) {
      throw new Error('Subscription coverage source data was not loaded');
    }
    return forecast;
  }

  public async reconcileDirty(
    limit: number,
    options: SubscriptionCoverageReconciliationOptions,
    ctx: RequestContext = {}
  ): Promise<SubscriptionCoverageReconciliationResult> {
    const requests = await this.repository.listDirty(limit, ctx);
    const keys = requests.map((request) => request.consolidation_key);
    const counters = await this.reconcileKeys(keys, options, ctx);
    if (!options.dryRun) {
      const failures = counters.failuresByKey;
      await Promise.all(
        requests.map(async (request) => {
          const error = failures.get(request.consolidation_key);
          if (error) {
            await this.repository.recordDirtyFailure(
              request.consolidation_key,
              Number(request.dirty_at),
              error,
              ctx
            );
            return;
          }
          await this.repository.deleteDirty(
            request.consolidation_key,
            Number(request.dirty_at),
            ctx
          );
        })
      );
    }
    return {
      mode: 'DIRTY',
      scanned: keys.length,
      ...counters.result,
      hasMore: requests.length === limit,
      lastConsolidationKey: keys.at(-1) ?? null
    };
  }

  public async reconcileFullPage(
    startAfter: string | undefined,
    limit: number,
    options: SubscriptionCoverageReconciliationOptions,
    ctx: RequestContext = {}
  ): Promise<SubscriptionCoverageReconciliationResult> {
    const keys = await this.repository.listDemonstratedIntentKeys(
      startAfter,
      limit,
      ctx
    );
    const counters = await this.reconcileKeys(keys, options, ctx);
    return {
      mode: 'FULL',
      scanned: keys.length,
      ...counters.result,
      hasMore: keys.length === limit,
      lastConsolidationKey: keys.at(-1) ?? null
    };
  }

  private async calculateCoverageBatch(
    keys: readonly string[],
    schedule: SubscriptionCoverageSchedule,
    ctx: RequestContext
  ): Promise<Map<string, ReconciledCoverage>> {
    const calculatedAtMs = this.now();
    const [sources, profiles] = await Promise.all([
      this.repository.loadSourceData(
        keys,
        schedule.drops.map((drop) => drop.tokenId),
        ctx
      ),
      this.repository.resolveCanonicalProfiles(keys, ctx)
    ]);
    const result = new Map<string, ReconciledCoverage>();
    for (const [key, source] of Array.from(sources.entries())) {
      result.set(key, {
        source,
        profile: profiles.get(key) ?? null,
        forecast: toForecast(source, schedule, calculatedAtMs)
      });
    }
    return result;
  }

  private async reconcileKeys(
    keys: readonly string[],
    options: SubscriptionCoverageReconciliationOptions,
    ctx: RequestContext
  ): Promise<{
    readonly result: Omit<
      SubscriptionCoverageReconciliationResult,
      'mode' | 'scanned' | 'hasMore' | 'lastConsolidationKey'
    >;
    readonly failuresByKey: Map<string, unknown>;
  }> {
    const counters = emptyCounters();
    const failuresByKey = new Map<string, unknown>();
    if (!keys.length) {
      return { result: counters, failuresByKey };
    }

    let forecasts: Map<string, ReconciledCoverage>;
    try {
      const schedule = await this.scheduleProvider.getSchedule();
      forecasts = await this.calculateCoverageBatch(keys, schedule, ctx);
    } catch (error) {
      for (const key of keys) {
        failuresByKey.set(key, error);
      }
      counters.failed = keys.length;
      this.logger.error('Subscription coverage batch calculation failed', {
        batch_size: keys.length,
        error
      });
      return { result: counters, failuresByKey };
    }

    const existingStates = await this.repository.readAlertStates(keys, ctx);
    const pendingNotificationDispatchIds: number[] = [];
    let pendingPushCount = 0;
    for (const key of keys) {
      const coverage = forecasts.get(key);
      if (!coverage) {
        const error = new Error('Missing subscription coverage source');
        failuresByKey.set(key, error);
        counters.failed++;
        continue;
      }
      try {
        incrementCount(counters.statusCounts, coverage.forecast.status);
        const notificationData = createNotificationData(
          coverage.forecast,
          coverage.profile
        );
        const warningStatus =
          coverage.forecast.status ===
            SubscriptionCoverageStatus.EarlyWarning ||
          coverage.forecast.status === SubscriptionCoverageStatus.RunningLow ||
          coverage.forecast.status ===
            SubscriptionCoverageStatus.ActionRequired;
        if (warningStatus && !coverage.profile) {
          counters.unroutable++;
        }
        const snapshot = {
          consolidationKey: key,
          status: coverage.forecast.status as SubscriptionCoverageAlertStatus,
          fingerprint: coverage.forecast.fingerprint,
          atRiskTokenId: coverage.forecast.nextUnfunded?.tokenId ?? null,
          fullyFundedDrops: coverage.forecast.fullyFundedDrops,
          requestedMints:
            coverage.forecast.nextUnfunded?.requestedMints ?? null,
          missingMints: coverage.forecast.nextUnfunded?.missingMints ?? null,
          recipientProfileId: coverage.profile?.profileId ?? null,
          notificationData
        };

        if (options.dryRun) {
          const decision = decideSubscriptionCoverageAlert(
            existingStates.get(key) ?? null,
            snapshot,
            alertPolicy(options)
          );
          if (decision.shouldNotify && notificationData) {
            counters.wouldNotify++;
          } else {
            counters.deduplicatedOrSuppressed++;
          }
          counters.succeeded++;
          continue;
        }

        const existingState = existingStates.get(key);
        if (
          existingState &&
          materiallyMatchesStoredState(existingState, snapshot)
        ) {
          counters.deduplicatedOrSuppressed++;
          counters.succeeded++;
          continue;
        }

        const writeResult = await this.repository.applyAlertSnapshot(
          snapshot,
          alertPolicy(options)
        );
        counters.baselined += writeResult.createdBaseline ? 1 : 0;
        counters.notificationsCreated += writeResult.notificationIds.length;
        if (!writeResult.notificationIds.length) {
          counters.deduplicatedOrSuppressed++;
        }
        if (writeResult.notificationStatus) {
          const notificationStatus =
            writeResult.notificationStatus as SubscriptionCoverageStatus;
          const mobilePushEligible =
            options.pushEnabled && isPushStatus(notificationStatus);
          if (
            mobilePushEligible ||
            notificationStatus === SubscriptionCoverageStatus.EarlyWarning
          ) {
            pendingNotificationDispatchIds.push(...writeResult.notificationIds);
          }
          if (mobilePushEligible) {
            pendingPushCount += writeResult.notificationIds.length;
          }
        }
        counters.succeeded++;
      } catch (error) {
        failuresByKey.set(key, error);
        counters.failed++;
      }
    }
    await this.dispatchNotificationsBestEffort(pendingNotificationDispatchIds);
    counters.pushesQueued += pendingPushCount;
    return { result: counters, failuresByKey };
  }

  private async dispatchNotificationsBestEffort(
    notificationIds: number[]
  ): Promise<void> {
    if (!notificationIds.length) {
      return;
    }
    try {
      await sendIdentityPushNotifications(notificationIds);
    } catch (error) {
      this.logger.error(
        'Failed to dispatch subscription coverage notifications',
        {
          notification_count: notificationIds.length,
          error
        }
      );
    }
  }
}

export const subscriptionCoverageReconciliationService =
  new SubscriptionCoverageReconciliationService();
