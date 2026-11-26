import { revokeRepBasedDropOverVotes } from '@/drops/participation-drops-over-vote-revocation';
import { appFeatures } from '@/app-features';
import { RateMatter } from '@/entities/IRating';
import {
  HELP_BOT_CREDIT_CATEGORY,
  HELP_BOT_HANDLE
} from '@/help-bot/help-bot.config';
import { identityMetricsSync } from '@/identity-metrics-sync';
import { Logger } from '@/logging';
import { isRetryableDbLockError } from '@/nextgen/nextgen-db-lock-retry';
import { aggregateScoresAndCountsByTarget } from '@/rateEventProcessingLoop/aggregations.helper';
import { RatingsDb, ratingsDb } from '@/rates/ratings.db';
import { ConnectionWrapper } from '@/sql-executor';
import { Time } from '@/time';
import {
  OvervotePreview,
  RepRatingsRemovalOvervotePreview,
  repRatingsRemovalOvervotePreview
} from './rep-ratings-removal-overvotes';
import {
  EventDelta,
  RemovalTotals,
  RepRatingsRemovalDb,
  repRatingsRemovalDb,
  RepScoreDelta,
  Totals
} from './rep-ratings-removal.db';
import {
  RaterRef,
  REP_RATINGS_REMOVE_JOB,
  RepRatingsRemovalMode,
  RepRatingsRemovalRefusal,
  RepRatingsRemovalRequest
} from './rep-ratings-removal.request';

/**
 * Deletes one rater's REP ratings in the given categories, and everything
 * 6529.io shows of them. Each batch, in one transaction:
 * - locks the rater's credit row first, as every credit-checked rating
 *   writer does, then the batch's rating rows by primary key;
 * - records each rating's key and old value in `rep_rating_removals`;
 * - deletes the ratings;
 * - applies the profile REP score aggregate deltas the rate event listener
 *   would, except for categories whose ratings never reached it;
 * - reconciles the wave votes of targets that vote in an active competition
 *   (revokeRepBasedDropOverVotes, as a rating write does when it lowers REP).
 *
 * Batches run at READ COMMITTED, as votes do, so the vote reconciliation
 * reads the votes and credit current when it takes the competition lock.
 *
 * After each batch commits, the targets' identities (`rep`, `level_raw` and
 * the other metrics) are recomputed from their sources by the identity
 * metrics sync (`syncScoped`), and the removal records are marked
 * recomputed. A run that stops in between leaves them unmarked, and the next
 * run recomputes them first. When every rating is gone, the rater's REP
 * rating log rows in the categories (profile REP history) are deleted.
 *
 * The removal itself writes no activity log row, notification or rating
 * event. Vote reconciliation, where it lowers a vote, records the vote change
 * and notifies the drop's author, as it does for any REP decrease.
 *
 * A batch that hits a deadlock or lock timeout is retried whole. Re-runs pick
 * up whatever is left; the end state is no rating, no log row and no
 * unrecomputed target in scope. `not_after` stops only deletes: recomputes
 * and log deletion, which only bring the rest in line, still finish.
 */

/**
 * Stop starting work with less than this, plus the slowest batch so far,
 * left in the invocation: time for one more batch's worth of overrun and the
 * read-back.
 */
export const STOP_MARGIN_MILLIS = Time.minutes(2).toMillis();
const LOCK_RETRY_ATTEMPTS = 5;
const LOCK_RETRY_BASE_DELAY_MILLIS = 500;
const ACTIVITY_LOG_DELETE_BATCH = 5000;

/**
 * The help bot's credits never produced rating events
 * (help-bot-credits.service writes `ratings` directly), so the profile REP
 * score aggregates never counted them. Only the bot's own ratings in its
 * credit category are treated so: anyone else's went through the rating
 * paths.
 */
function isOutsideRepScoreAggregates(
  category: string,
  rater: string,
  helpBotProfileId: string | null
): boolean {
  return category === HELP_BOT_CREDIT_CATEGORY && rater === helpBotProfileId;
}

export type StopReason = 'TIME_BUDGET' | 'NOT_AFTER' | 'MAX_RATINGS';

export interface RepRatingsRemovalLimits {
  /** Milliseconds left before the invocation must have returned. */
  readonly remainingMillis: () => number;
}

export interface RepChange {
  readonly rep_recipient_id: string;
  readonly rep_giver_id: string;
  readonly credit_category: string;
}

export interface RepRatingsRemovalDeps {
  readonly db: RepRatingsRemovalDb;
  readonly ratingsDb: Pick<
    RatingsDb,
    'lockRaterCreditOnMatter' | 'executeNativeQueriesInTransaction'
  >;
  readonly revokeOvervotes: (
    change: RepChange,
    connection: ConnectionWrapper<any>
  ) => Promise<void>;
  readonly isOvervoteRevocationEnabled: () => boolean;
  /** Recomputes the identities of these profiles from their sources. */
  readonly recomputeIdentities: (profileIds: string[]) => Promise<void>;
  readonly overvotePreview: Pick<RepRatingsRemovalOvervotePreview, 'preview'>;
  /** Log rows deleted per statement (default 5000). */
  readonly activityLogDeleteBatch?: number;
  readonly now: () => number;
  readonly sleep: (millis: number) => Promise<void>;
}

export interface DryRunCategoryReport {
  readonly category: string;
  /** The rater's ratings, zero or not: all are deleted. */
  readonly ratings: number;
  readonly non_zero_ratings: number;
  readonly rep_sum: number;
  readonly targets_real_handle: number;
  readonly targets_placeholder_handle: number;
  readonly targets_other: number;
  /** Other raters' REP ratings in the category: left as they are. */
  readonly other_raters_ratings: number;
  /** The rater's REP rating log rows in the category. */
  readonly activity_logs: number;
  readonly rep_score_aggregates: 'ADJUSTED' | 'NOT_COUNTED';
  /**
   * For NOT_COUNTED: rating events recorded for these ratings anyway (the
   * over-rate cleanup could cut the bot's credits before they were exempt),
   * and what they added to the aggregates. APPLY takes exactly that back.
   * Null for ADJUSTED.
   */
  readonly rating_events: {
    readonly events: number;
    readonly score: number;
    readonly rater_count: number;
  } | null;
  /** Removal records from earlier APPLY runs. */
  readonly removed_before: {
    readonly ratings: number;
    readonly rep_sum: number;
    readonly not_recomputed: number;
  };
}

export interface ApplyCategoryReport {
  readonly category: string;
  readonly ratings_deleted: number;
  readonly rep_removed: number;
  readonly remaining_ratings: number;
  readonly remaining_rep_sum: number;
  readonly removal_records: number;
  readonly removed_rep_sum: number;
  readonly not_recomputed: number;
  /** Counted once no rating is left in scope; null before. */
  readonly remaining_activity_logs: number | null;
}

export interface RepRatingsRemovalDryRunResult {
  readonly job: typeof REP_RATINGS_REMOVE_JOB;
  readonly mode: RepRatingsRemovalMode.DRY_RUN;
  readonly rater_profile_id: string;
  /** True when nothing is left to delete or recompute. */
  readonly complete: boolean;
  readonly categories: DryRunCategoryReport[];
  readonly totals: {
    readonly ratings: number;
    readonly rep_sum: number;
    readonly distinct_targets: number;
    readonly activity_logs: number;
  };
  readonly overvotes: OvervotePreview;
  readonly elapsed_ms: number;
}

export interface RepRatingsRemovalApplyResult {
  readonly job: typeof REP_RATINGS_REMOVE_JOB;
  readonly mode: RepRatingsRemovalMode.APPLY;
  readonly rater_profile_id: string;
  /** True when no rating, log row or unrecomputed target is left in scope. */
  readonly complete: boolean;
  readonly stopped_by: StopReason | null;
  readonly this_run: {
    readonly batches: number;
    readonly ratings_deleted: number;
    readonly rep_removed: number;
    readonly targets_recomputed: number;
    readonly voters_overvote_checked: number;
    readonly activity_logs_deleted: number;
    readonly lock_retries: number;
    readonly slowest_batch_ms: number;
    readonly elapsed_ms: number;
  };
  readonly categories: ApplyCategoryReport[];
  /** Read back after the run. */
  readonly read_back: {
    readonly remaining_ratings: number;
    readonly remaining_rep_sum: number;
    readonly removal_records: number;
    readonly removed_rep_sum: number;
    readonly not_recomputed: number;
    /** Counted once no rating is left in scope; null before. */
    readonly remaining_activity_logs: number | null;
  };
}

export type RepRatingsRemovalResult =
  | RepRatingsRemovalDryRunResult
  | RepRatingsRemovalApplyResult;

interface BatchRequest {
  readonly rater: string;
  readonly category: string;
  /** Exclusive: the batch starts after this target. */
  readonly after: string;
  readonly limit: number;
  readonly adjustAggregates: boolean;
  /** For ratings outside the aggregates: what their events added. */
  readonly eventDeltas: ReadonlyMap<string, EventDelta> | null;
}

interface BatchResult {
  readonly lastTarget: string;
  /** Targets whose rating was deleted, in target order. */
  readonly targets: string[];
  readonly repRemoved: number;
  readonly overvoteChecked: number;
}

/** Who and what a run removes. */
interface Scope {
  readonly rater: string;
  readonly categories: string[];
  /** Categories whose removals skip the REP score aggregate deltas. */
  readonly notCounted: ReadonlySet<string>;
}

interface RunState {
  batches: number;
  slowestBatchMs: number;
  deleted: number;
  repRemoved: number;
  recomputed: number;
  overvoteChecked: number;
  logsDeleted: number;
  lockRetries: number;
  readonly byCategory: Map<string, { deleted: number; repRemoved: number }>;
}

function sum(values: number[]): number {
  return values.reduce((acc, it) => acc + it, 0);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The aggregate deltas the rate event listener would apply for these
 * ratings going to 0: score down, one rater less for each non-zero one.
 */
function listenerDeltasOfRemoval(
  removed: { matter_target_id: string; rating: number }[]
): RepScoreDelta[] {
  return Object.entries(
    aggregateScoresAndCountsByTarget(
      removed.map((it) => ({
        target_profile_id: it.matter_target_id,
        old_score: it.rating,
        new_score: 0
      }))
    )
  )
    .filter(([, delta]) => delta.score !== 0 || delta.rater_count !== 0)
    .map(([profile_id, delta]) => ({
      profile_id,
      score: delta.score,
      rater_count: delta.rater_count
    }));
}

/** For ratings outside the aggregates: take back what their events added. */
function eventDeltasOfRemoval(
  targets: string[],
  eventDeltas: ReadonlyMap<string, EventDelta> | null
): RepScoreDelta[] {
  const deltas: RepScoreDelta[] = [];
  for (const target of targets) {
    const delta = eventDeltas?.get(target);
    if (delta && (delta.score !== 0 || delta.rater_count !== 0)) {
      deltas.push({
        profile_id: target,
        score: -delta.score,
        rater_count: -delta.rater_count
      });
    }
  }
  return deltas;
}

function summarizeEventDeltas({
  events,
  byTarget
}: {
  events: number;
  byTarget: Map<string, EventDelta>;
}): { events: number; score: number; rater_count: number } {
  const deltas = Array.from(byTarget.values());
  return {
    events,
    score: sum(deltas.map((it) => it.score)),
    rater_count: sum(deltas.map((it) => it.rater_count))
  };
}

export class RepRatingsRemovalJob {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(private readonly deps: RepRatingsRemovalDeps) {}

  async run(
    request: RepRatingsRemovalRequest,
    limits: RepRatingsRemovalLimits
  ): Promise<RepRatingsRemovalResult> {
    const startedAt = this.deps.now();
    this.logger.info(
      `[START] [MODE ${request.mode}] [CATEGORIES ${request.categories.length}] [BATCH SIZE ${request.batchSize}]`
    );
    const rater = await this.resolveRater(request.rater);
    const helpBotProfileId =
      await this.deps.db.findProfileIdByHandle(HELP_BOT_HANDLE);
    const scope: Scope = {
      rater,
      categories: request.categories,
      notCounted: new Set(
        request.categories.filter((category) =>
          isOutsideRepScoreAggregates(category, rater, helpBotProfileId)
        )
      )
    };
    await this.preflight(scope, request);
    const result =
      request.mode === RepRatingsRemovalMode.DRY_RUN
        ? await this.dryRun(scope, startedAt)
        : await this.apply(scope, request, limits, startedAt);
    this.logger.info(`[RESULT] ${JSON.stringify(result)}`);
    return result;
  }

  private async resolveRater(rater: RaterRef): Promise<string> {
    if ('profileId' in rater) {
      return rater.profileId;
    }
    const profileId = await this.deps.db.findProfileIdByHandle(rater.handle);
    if (!profileId) {
      throw new RepRatingsRemovalRefusal(
        'no profile has the rater_handle given'
      );
    }
    return profileId;
  }

  /**
   * Refuses before any change: a missing table, rater or category, or a
   * category with too few of the rater's ratings. A category whose ratings
   * are all gone passes once a removal record shows this job removed them.
   */
  private async preflight(
    { rater }: Scope,
    request: RepRatingsRemovalRequest
  ): Promise<void> {
    const { db } = this.deps;
    if (!(await db.removalsTableExists())) {
      throw new RepRatingsRemovalRefusal(
        'the rep_rating_removals table does not exist yet: deploy dbMigrationsLoop with this change first'
      );
    }
    if (!(await db.profileExists(rater))) {
      throw new RepRatingsRemovalRefusal('the rater profile does not exist');
    }
    for (let index = 0; index < request.categories.length; index++) {
      const category = request.categories[index];
      const name = `categories[${index}] ${JSON.stringify(category)}`;
      const rows = await db.countCategoryRows(rater, category);
      const removed = (await db.getRemovalTotals(rater, category)).ratings;
      if (rows + removed === 0) {
        throw new RepRatingsRemovalRefusal(
          `${name}: the rater has no REP rating in it`
        );
      }
      if (rows + removed <= request.minTargetsPerCategory) {
        throw new RepRatingsRemovalRefusal(
          `${name}: the rater rated ${rows + removed} targets in it, not more than ${request.minTargetsPerCategory}`
        );
      }
    }
  }

  private async dryRun(
    { rater, categories: inScope, notCounted }: Scope,
    startedAt: number
  ): Promise<RepRatingsRemovalDryRunResult> {
    const { db } = this.deps;
    const otherRaters = await db.countOtherRatersRows(rater, inScope);
    const logs = await db.countActivityLogs(rater, inScope, 'READER');
    const categories: DryRunCategoryReport[] = [];
    for (const category of inScope) {
      const scope = await db.getCategoryScope(rater, category);
      const removed = await db.getRemovalTotals(rater, category);
      categories.push({
        category,
        ratings: scope.ratings,
        non_zero_ratings: scope.nonZeroRatings,
        rep_sum: scope.repSum,
        targets_real_handle: scope.realHandle,
        targets_placeholder_handle: scope.placeholderHandle,
        targets_other:
          scope.ratings - scope.realHandle - scope.placeholderHandle,
        other_raters_ratings: otherRaters.get(category) ?? 0,
        activity_logs: logs.get(category) ?? 0,
        rep_score_aggregates: notCounted.has(category)
          ? 'NOT_COUNTED'
          : 'ADJUSTED',
        rating_events: notCounted.has(category)
          ? summarizeEventDeltas(await db.getRatingEventDeltas(rater, category))
          : null,
        removed_before: {
          ratings: removed.ratings,
          rep_sum: removed.repSum,
          not_recomputed: removed.notRecomputed
        }
      });
    }
    const ratings = sum(categories.map((it) => it.ratings));
    const activityLogs = sum(categories.map((it) => it.activity_logs));
    const notRecomputed = sum(
      categories.map((it) => it.removed_before.not_recomputed)
    );
    return {
      job: REP_RATINGS_REMOVE_JOB,
      mode: RepRatingsRemovalMode.DRY_RUN,
      rater_profile_id: rater,
      complete: ratings === 0 && activityLogs === 0 && notRecomputed === 0,
      categories,
      totals: {
        ratings,
        rep_sum: sum(categories.map((it) => it.rep_sum)),
        distinct_targets: await db.countDistinctTargets(rater, inScope),
        activity_logs: activityLogs
      },
      overvotes: await this.deps.overvotePreview.preview(
        rater,
        await db.findActiveVoterRatings(rater, inScope)
      ),
      elapsed_ms: this.deps.now() - startedAt
    };
  }

  private async apply(
    scope: Scope,
    request: RepRatingsRemovalRequest,
    limits: RepRatingsRemovalLimits,
    startedAt: number
  ): Promise<RepRatingsRemovalApplyResult> {
    const { rater } = scope;
    const state: RunState = {
      batches: 0,
      slowestBatchMs: 0,
      deleted: 0,
      repRemoved: 0,
      recomputed: 0,
      overvoteChecked: 0,
      logsDeleted: 0,
      lockRetries: 0,
      byCategory: new Map()
    };
    // Targets an earlier run deleted but did not recompute come first.
    let stoppedBy = await this.recomputeLeftovers(
      rater,
      request,
      limits,
      state
    );
    for (
      let index = 0;
      !stoppedBy && index < request.categories.length;
      index++
    ) {
      stoppedBy = await this.removeCategory(
        scope,
        request,
        index,
        limits,
        state
      );
    }
    if (!stoppedBy) {
      stoppedBy = await this.deleteActivityLogs(
        rater,
        request.categories,
        limits,
        state
      );
    }
    const categories = await this.readBack(rater, request, state);
    const remainingRatings = sum(categories.map((it) => it.remaining_ratings));
    const readBack = {
      remaining_ratings: remainingRatings,
      remaining_rep_sum: sum(categories.map((it) => it.remaining_rep_sum)),
      removal_records: sum(categories.map((it) => it.removal_records)),
      removed_rep_sum: sum(categories.map((it) => it.removed_rep_sum)),
      not_recomputed: sum(categories.map((it) => it.not_recomputed)),
      remaining_activity_logs: remainingRatings
        ? null
        : sum(categories.map((it) => it.remaining_activity_logs ?? 0))
    };
    return {
      job: REP_RATINGS_REMOVE_JOB,
      mode: RepRatingsRemovalMode.APPLY,
      rater_profile_id: rater,
      complete:
        !stoppedBy &&
        readBack.remaining_ratings === 0 &&
        readBack.not_recomputed === 0 &&
        readBack.remaining_activity_logs === 0,
      stopped_by: stoppedBy,
      this_run: {
        batches: state.batches,
        ratings_deleted: state.deleted,
        rep_removed: state.repRemoved,
        targets_recomputed: state.recomputed,
        voters_overvote_checked: state.overvoteChecked,
        activity_logs_deleted: state.logsDeleted,
        lock_retries: state.lockRetries,
        slowest_batch_ms: state.slowestBatchMs,
        elapsed_ms: this.deps.now() - startedAt
      },
      categories,
      read_back: readBack
    };
  }

  /**
   * The state after the run, from the primary. Log rows are counted only
   * once no rating is left in scope: before that they are not deleted yet,
   * and counting them reads every one of the rater's REP log rows.
   */
  private async readBack(
    rater: string,
    request: RepRatingsRemovalRequest,
    state: RunState
  ): Promise<ApplyCategoryReport[]> {
    const { db } = this.deps;
    const remainingByCategory = new Map<string, Totals>();
    for (const category of request.categories) {
      remainingByCategory.set(category, await db.getRemaining(rater, category));
    }
    const ratingsLeft = Array.from(remainingByCategory.values()).some(
      (it) => it.ratings > 0
    );
    const logs = ratingsLeft
      ? null
      : await db.countActivityLogs(rater, request.categories, 'PRIMARY');
    const reports: ApplyCategoryReport[] = [];
    for (const category of request.categories) {
      const remaining = remainingByCategory.get(category)!;
      const removed: RemovalTotals = await db.getRemovalTotals(rater, category);
      const thisRun = state.byCategory.get(category);
      reports.push({
        category,
        ratings_deleted: thisRun?.deleted ?? 0,
        rep_removed: thisRun?.repRemoved ?? 0,
        remaining_ratings: remaining.ratings,
        remaining_rep_sum: remaining.repSum,
        removal_records: removed.ratings,
        removed_rep_sum: removed.repSum,
        not_recomputed: removed.notRecomputed,
        remaining_activity_logs: logs ? (logs.get(category) ?? 0) : null
      });
    }
    return reports;
  }

  private timeIsUp(limits: RepRatingsRemovalLimits, state: RunState): boolean {
    return limits.remainingMillis() < STOP_MARGIN_MILLIS + state.slowestBatchMs;
  }

  /** Why no further rating may be deleted in this run, if any. */
  private deleteStopReason(
    request: RepRatingsRemovalRequest,
    limits: RepRatingsRemovalLimits,
    state: RunState
  ): StopReason | null {
    if (request.maxRatings !== null && state.deleted >= request.maxRatings) {
      return 'MAX_RATINGS';
    }
    if (
      request.notAfterMillis !== null &&
      this.deps.now() >= request.notAfterMillis
    ) {
      return 'NOT_AFTER';
    }
    return this.timeIsUp(limits, state) ? 'TIME_BUDGET' : null;
  }

  /**
   * Recomputes the identities of targets whose removal records are not
   * marked recomputed: left by a run that stopped between a batch's commit
   * and its recompute.
   */
  private async recomputeLeftovers(
    rater: string,
    request: RepRatingsRemovalRequest,
    limits: RepRatingsRemovalLimits,
    state: RunState
  ): Promise<StopReason | null> {
    for (;;) {
      if (this.timeIsUp(limits, state)) {
        return 'TIME_BUDGET';
      }
      const targets = await this.deps.db.findNotRecomputedTargets(
        rater,
        request.categories,
        request.batchSize
      );
      if (!targets.length) {
        return null;
      }
      const marked = await this.recompute(
        rater,
        request.categories,
        targets,
        state
      );
      if (!marked) {
        // Only a removal newer than this recompute stays unmarked. Reading
        // the same targets again would loop.
        throw new Error(
          'removal records were left unmarked after their targets were recomputed'
        );
      }
      this.logger.info(`[RECOMPUTED LEFTOVER TARGETS ${targets.length}]`);
    }
  }

  /**
   * Recomputes the targets' identities and marks their removal records done.
   * Returns how many records it marked.
   */
  private async recompute(
    rater: string,
    categories: string[],
    targets: string[],
    state: RunState
  ): Promise<number> {
    const startedAt = this.deps.now();
    await this.deps.recomputeIdentities(targets);
    const marked = await this.deps.db.markRecomputed(
      {
        rater_profile_id: rater,
        categories,
        targets,
        recomputedAt: this.deps.now()
      },
      startedAt
    );
    state.recomputed += targets.length;
    return marked;
  }

  /**
   * Deletes the category's ratings in target order, then scans once more
   * from the first target for any rating created behind the scan. Returns
   * why it stopped early, or null when the category has no rating left.
   */
  private async removeCategory(
    { rater, notCounted }: Scope,
    request: RepRatingsRemovalRequest,
    index: number,
    limits: RepRatingsRemovalLimits,
    state: RunState
  ): Promise<StopReason | null> {
    const category = request.categories[index];
    const adjustAggregates = !notCounted.has(category);
    // What rating events added for ratings written without them: taken back
    // per target as its rating goes. Events do not change during the run.
    const eventDeltas = adjustAggregates
      ? null
      : (await this.deps.db.getRatingEventDeltas(rater, category)).byTarget;
    this.logger.info(
      `[CATEGORY ${index + 1}/${request.categories.length}] [STARTING]`
    );
    let after = '';
    for (;;) {
      const stop = this.deleteStopReason(request, limits, state);
      if (stop) {
        return stop;
      }
      const limit =
        request.maxRatings === null
          ? request.batchSize
          : Math.min(request.batchSize, request.maxRatings - state.deleted);
      const batchStartedAt = this.deps.now();
      const batch = await this.removeBatchWithRetry(
        { rater, category, after, limit, adjustAggregates, eventDeltas },
        limits,
        state
      );
      if (batch === 'TIME_BUDGET') {
        return batch;
      }
      if (!batch) {
        if (after === '') {
          return null;
        }
        after = '';
        continue;
      }
      after = batch.lastTarget;
      state.batches++;
      state.deleted += batch.targets.length;
      state.repRemoved += batch.repRemoved;
      state.overvoteChecked += batch.overvoteChecked;
      const forCategory = state.byCategory.get(category) ?? {
        deleted: 0,
        repRemoved: 0
      };
      forCategory.deleted += batch.targets.length;
      forCategory.repRemoved += batch.repRemoved;
      state.byCategory.set(category, forCategory);
      if (batch.targets.length) {
        await this.recompute(rater, [category], batch.targets, state);
      }
      const batchMs = this.deps.now() - batchStartedAt;
      state.slowestBatchMs = Math.max(state.slowestBatchMs, batchMs);
      this.logger.info(
        `[CATEGORY ${index + 1}/${request.categories.length}] [BATCH ${state.batches}] [DELETED ${batch.targets.length}] [REP REMOVED ${batch.repRemoved}] [OVERVOTE CHECKED ${batch.overvoteChecked}] [RUN DELETED ${state.deleted}] [${batchMs} ms]`
      );
    }
  }

  private async removeBatchWithRetry(
    batch: BatchRequest,
    limits: RepRatingsRemovalLimits,
    state: RunState
  ): Promise<BatchResult | null | 'TIME_BUDGET'> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.deps.ratingsDb.executeNativeQueriesInTransaction(
          (connection) => this.removeBatch(batch, connection),
          // As votes run: the reconciliation must read the votes and credit
          // current when it locks the competition, not the batch's first read.
          { isolationLevel: 'READ COMMITTED' }
        );
      } catch (error) {
        if (!isRetryableDbLockError(error) || attempt >= LOCK_RETRY_ATTEMPTS) {
          throw error;
        }
        const delay = LOCK_RETRY_BASE_DELAY_MILLIS * 2 ** (attempt - 1);
        // The batch rolled back; retry only with time for it and the read-back.
        if (
          limits.remainingMillis() - delay <
          STOP_MARGIN_MILLIS + state.slowestBatchMs
        ) {
          this.logger.warn(
            `[LOCK ERROR] [NO TIME TO RETRY] [ATTEMPT ${attempt}] ${error}`
          );
          return 'TIME_BUDGET';
        }
        state.lockRetries++;
        this.logger.warn(
          `[LOCK RETRY] [ATTEMPT ${attempt}/${LOCK_RETRY_ATTEMPTS}] ${error}`
        );
        await this.deps.sleep(delay);
      }
    }
  }

  /** One transaction: the category's next `limit` ratings after `after`. */
  private async removeBatch(
    {
      rater,
      category,
      after,
      limit,
      adjustAggregates,
      eventDeltas
    }: BatchRequest,
    connection: ConnectionWrapper<any>
  ): Promise<BatchResult | null> {
    const { db, ratingsDb } = this.deps;
    // First lock, as every credit-checked writer of the rater's ratings takes.
    await ratingsDb.lockRaterCreditOnMatter(
      { rater_profile_id: rater, matter: RateMatter.REP },
      connection
    );
    const found = await db.findTargetsAfter(
      { rater_profile_id: rater, matter_category: category, after, limit },
      connection
    );
    if (!found.length) {
      return null;
    }
    // Locked by primary key; the values read under the lock are the ones
    // removed.
    const removed = (
      await db.lockRatings(
        { rater_profile_id: rater, matter_category: category, targets: found },
        connection
      )
    ).sort((a, b) => compareStrings(a.matter_target_id, b.matter_target_id));
    const targets = removed.map((it) => it.matter_target_id);
    let overvoteChecked = 0;
    if (targets.length) {
      const removedAt = this.deps.now();
      await db.insertRemovals(
        removed.map((it) => ({
          rater_profile_id: rater,
          matter_category: category,
          matter_target_id: it.matter_target_id,
          old_rating: it.rating,
          removed_at: removedAt
        })),
        connection
      );
      await db.deleteRatings(
        { rater_profile_id: rater, matter_category: category, targets },
        connection
      );
      await db.addRepScoreDeltas(
        adjustAggregates
          ? listenerDeltasOfRemoval(removed)
          : eventDeltasOfRemoval(targets, eventDeltas),
        connection
      );
      overvoteChecked = await this.revokeOvervotes(
        rater,
        category,
        removed.filter((it) => it.rating > 0).map((it) => it.matter_target_id),
        connection
      );
    }
    return {
      lastTarget: found[found.length - 1],
      targets,
      repRemoved: sum(removed.map((it) => it.rating)),
      overvoteChecked
    };
  }

  /**
   * A lowered REP total can leave a target's votes above the credit of a
   * wave that counts this REP (ratingsDb.updateRating does the same per
   * rating). Only targets with votes in an active REP-credit competition can
   * be affected, so only those are reconciled.
   */
  private async revokeOvervotes(
    rater: string,
    category: string,
    lowered: string[],
    connection: ConnectionWrapper<any>
  ): Promise<number> {
    if (!lowered.length || !this.deps.isOvervoteRevocationEnabled()) {
      return 0;
    }
    const voters = (await this.deps.db.findActiveVoters(lowered, connection))
      .slice()
      .sort(compareStrings);
    for (const voter of voters) {
      await this.deps.revokeOvervotes(
        {
          rep_recipient_id: voter,
          rep_giver_id: rater,
          credit_category: category
        },
        connection
      );
    }
    return voters.length;
  }

  /** Deletes the rater's REP rating log rows in the categories. */
  private async deleteActivityLogs(
    rater: string,
    categories: string[],
    limits: RepRatingsRemovalLimits,
    state: RunState
  ): Promise<StopReason | null> {
    for (;;) {
      if (this.timeIsUp(limits, state)) {
        return 'TIME_BUDGET';
      }
      const limit =
        this.deps.activityLogDeleteBatch ?? ACTIVITY_LOG_DELETE_BATCH;
      const deleted = await this.deps.db.deleteActivityLogs(
        rater,
        categories,
        limit
      );
      state.logsDeleted += deleted;
      if (deleted < limit) {
        this.logger.info(`[ACTIVITY LOGS DELETED ${state.logsDeleted}]`);
        return null;
      }
    }
  }
}

export const repRatingsRemovalJob = new RepRatingsRemovalJob({
  db: repRatingsRemovalDb,
  ratingsDb,
  revokeOvervotes: revokeRepBasedDropOverVotes,
  isOvervoteRevocationEnabled: () =>
    appFeatures.isDropOvervoteRevocationEnabled(),
  recomputeIdentities: async (profileIds) => {
    await identityMetricsSync.syncScoped({ consolidationKeys: [], profileIds });
  },
  overvotePreview: repRatingsRemovalOvervotePreview,
  now: () => Time.currentMillis(),
  sleep: (millis) => new Promise((resolve) => setTimeout(resolve, millis))
});
