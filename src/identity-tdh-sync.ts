import { randomUUID } from 'node:crypto';
import { invalidateWaveUnreadCache } from '@/api/waves/wave-unread-cache';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from '@/api/waves/wave-score.service';
import { revokeTdhBasedDropWavesOverVotesPerCompetition } from '@/drops/participation-drops-over-vote-revocation';
import { identitiesDb } from '@/identities/identities.db';
import { identityConsolidationEffects } from '@/identity';
import {
  IdentityMetricsScopedSyncOptions,
  identityMetricsSync,
  IdentityMetricsSyncOptions
} from '@/identity-metrics-sync';
import { identityTdhSyncScopeDb } from '@/identity-tdh-sync-scope.db';
import {
  IdentityTdhSyncProgress,
  identityTdhSyncStateDb
} from '@/identity-tdh-sync-state.db';
import { Logger } from '@/logging';
import * as notifier from '@/notifier';
import * as sentryContext from '@/sentry.context';
import { sqs } from '@/sqs';
import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import { XTDH_LOOP_PHASE } from '@/xtdh/xtdh-loop-phase';

const logger = Logger.get('IDENTITY_TDH_SYNC');
const XTDH_LOOP_QUEUE_NAME = 'xtdh-start.fifo';

/** Longer than the loops' 15 minute Lambda timeout. */
const LEASE_TTL_MS = Time.minutes(16).toMillis();
/** How often a running sync extends its lease while it walks the chunks. */
const LEASE_RENEW_MS = Time.minutes(1).toMillis();

/** Another invocation took over the lease: stop before writing more. */
class IdentityTdhSyncLeaseLostError extends Error {
  constructor() {
    super('Identities sync lease was taken over; stopping this run');
    this.name = 'IdentityTdhSyncLeaseLostError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Extends this run's lease, and fails the run if it no longer holds it. The
 * TTL alone outlives a Lambda invocation; renewing keeps that true for any
 * runtime, so two runs never do B to E at once.
 */
function leaseKeeper(owner: string) {
  let renewedAt = Time.currentMillis();
  const renew = async () => {
    if (!(await identityTdhSyncStateDb.acquireLease(owner, LEASE_TTL_MS)))
      throw new IdentityTdhSyncLeaseLostError();
    renewedAt = Time.currentMillis();
  };
  return {
    renew,
    renewIfDue: async () => {
      if (Time.currentMillis() - renewedAt >= LEASE_RENEW_MS) await renew();
    }
  };
}

export type IdentityTdhSyncOutcome =
  | 'SYNCED'
  | 'UP_TO_DATE'
  | 'LEASE_HELD'
  | 'BUDGET_USED'
  | 'FULL_WALK_DEFERRED';

/**
 * Identities sync time per delegationsLoop invocation. The sync stops cleanly
 * between chunks once it is spent and the next invocation resumes it, so no
 * invocation nears the 900 s Lambda timeout however cold the pages are.
 */
const IDENTITY_SYNC_BUDGET_MS = Time.minutes(5).toMillis();
/**
 * The least time delegationsLoop's resume gets, even when its delegations
 * work used up the budget: enough for a full walk to make progress (it keeps
 * a checkpoint), so a walk is never starved by long invocations.
 */
const RESUME_MINIMUM_SLICE_MS = Time.seconds(150).toMillis();
/**
 * No sync runs past this, from invocation start, whatever its floor: it
 * leaves three minutes of the 900 s Lambda limit for D, E and the loop.
 */
const SYNC_HARD_STOP_MS = Time.minutes(12).toMillis();
/**
 * A scoped walk resolving to more identities than this, if stopped by the
 * budget, falls back to a full walk (which keeps a checkpoint) at once, even
 * before its first chunk ran: about a tenth of all identities.
 */
const SCOPED_WALK_MAX_IDENTITIES = 100_000;
let invocationStartedAt: number | null = null;
let invocationDeadline: number | null = null;

/** At invocation start: the syncs of this invocation share one budget. */
export function startIdentitySyncBudget(
  budgetMs: number = IDENTITY_SYNC_BUDGET_MS,
  startedAt: number = Time.currentMillis()
): void {
  invocationStartedAt = startedAt;
  invocationDeadline = invocationStartedAt + budgetMs;
}

/**
 * When a sync starting `now` must stop: the invocation's budget, or, when a
 * minimum slice is asked for and the budget leaves less, `now` plus the whole
 * slice. A slice that would run past the hard stop is not shortened: the
 * sync gets only the (spent) budget, so it does not start.
 */
export function resolveSyncDeadline({
  now,
  startedAt,
  budgetDeadline,
  minimumSliceMs
}: {
  now: number;
  startedAt: number | null;
  budgetDeadline: number | null;
  minimumSliceMs: number;
}): { deadline: number; floorApplied: boolean } {
  const deadline = budgetDeadline ?? now + IDENTITY_SYNC_BUDGET_MS;
  if (minimumSliceMs <= 0 || now + minimumSliceMs <= deadline) {
    return { deadline, floorApplied: false };
  }
  const hardStop = (startedAt ?? now) + SYNC_HARD_STOP_MS;
  if (now + minimumSliceMs > hardStop) {
    return { deadline, floorApplied: false };
  }
  return { deadline: now + minimumSliceMs, floorApplied: true };
}

export type IdentityTdhSyncOptions = IdentityMetricsSyncOptions & {
  /** Test hook: also stops the run, as a spent budget does. */
  readonly budgetSpent?: () => boolean;
  /**
   * A sync that needs a full walk is left pending, untouched, for a later
   * call: delegationsLoop's resume after its delegations work.
   */
  readonly deferFullWalk?: boolean;
  /** Run at least this long, past the invocation's budget if need be. */
  readonly minimumSliceMs?: number;
};

/**
 * The longest a rating transaction can stay open after it sets
 * `last_modified`: the 15-minute Lambda limit, plus slack. A scoped sync
 * rechecks ratings modified since the previous walk started, less this.
 */
const RATINGS_WATERMARK_MARGIN_SECONDS = Time.minutes(20).toSeconds();
/** Step C walks every identity at least this often (daily reconciliation). */
const FULL_WALK_INTERVAL_MS = Time.hours(25).toMillis();

type MetricsSyncPlan =
  | { readonly mode: 'FULL'; readonly reason: string }
  | { readonly mode: 'SCOPED'; readonly ratingsSince: number };

/**
 * Step C walks every identity after a write that recorded no scope (a full
 * TDH rewrite, or a write by older code), after a scoped walk that did not
 * finish within one budget, before a ratings watermark exists, and once a
 * day. Otherwise it recomputes only what the pending generations changed:
 * the consolidation keys whose TDH step A changed, the identities and merged
 * profiles step B wrote, and the targets of ratings modified since the
 * previous walk started (see `syncScopedMetrics`). None of these conditions
 * change until the generation is synced, so a resumed sync plans the same
 * walk, except that a scoped one can become full: a scoped walk never moves
 * the full walk's checkpoint, which then starts from the first key.
 */
async function planMetricsSync(
  progress: IdentityTdhSyncProgress
): Promise<MetricsSyncPlan> {
  if (
    await identityTdhSyncScopeDb.isFullWalkRequired(
      progress.syncedGeneration,
      progress.pendingGeneration
    )
  ) {
    return { mode: 'FULL', reason: 'SCOPED WALK DID NOT FINISH' };
  }
  const recorded = await identityTdhSyncScopeDb.countRecordedGenerations(
    progress.syncedGeneration,
    progress.pendingGeneration
  );
  if (recorded < progress.pendingGeneration - progress.syncedGeneration) {
    return { mode: 'FULL', reason: 'UNSCOPED TDH WRITE' };
  }
  const ratingsSince = await identityTdhSyncStateDb.readSyncedRatingsSince();
  if (ratingsSince <= 0) {
    return { mode: 'FULL', reason: 'NO RATINGS WATERMARK' };
  }
  const lastFullWalkAt = await identityTdhSyncStateDb.readLastFullWalkAt();
  if (Time.currentMillis() - lastFullWalkAt >= FULL_WALK_INTERVAL_MS) {
    return { mode: 'FULL', reason: 'DAILY RECONCILIATION' };
  }
  return { mode: 'SCOPED', ratingsSince };
}

/**
 * Step C on a scoped plan. Every REP and CIC ratings writer (ratings.db,
 * help-bot credits) sets `ratings.last_modified` to the database clock in
 * the statement that changes the rating, and commits within the Lambda limit,
 * so `last_modified` >= commit time - margin. The previous walk started at T
 * and stored T - margin; it read every rating committed before T. A rating
 * committed after T has `last_modified` >= T - margin, so this scan, from
 * that watermark, finds it. The scan is a consistent read on the writer and
 * locks nothing; ratings committed after it are left to the next walk, which
 * starts from this walk's start less the margin.
 */
async function syncScopedMetrics(
  plan: Extract<MetricsSyncPlan, { mode: 'SCOPED' }>,
  progress: IdentityTdhSyncProgress,
  generation: number,
  options: Omit<
    IdentityMetricsScopedSyncOptions,
    'consolidationKeys' | 'profileIds'
  >
) {
  const scope = await identityTdhSyncScopeDb.readScope(
    progress.syncedGeneration,
    generation
  );
  const rated = await identityTdhSyncScopeDb.findRatedProfilesSince(
    plan.ratingsSince
  );
  logger.info(
    `[C SCOPED] [GENERATION ${generation}] [KEYS ${scope.consolidationKeys.length}] [PROFILES ${scope.profileIds.length}] [RATED ${rated.length}]`
  );
  return identityMetricsSync.syncScoped({
    ...options,
    consolidationKeys: scope.consolidationKeys,
    profileIds: [...scope.profileIds, ...rated]
  });
}

/** After the sync: the xTDH loop recomputes against the synced identities. */
async function enqueueXTdhUniverseRecalculation(): Promise<void> {
  await sqs.sendToQueueName({
    queueName: XTDH_LOOP_QUEUE_NAME,
    message: {
      phase: XTDH_LOOP_PHASE.UNIVERSE,
      queued_at_ms: Date.now()
    }
  });
}

/**
 * Tells TDH consumers the synced identities are ready. A full TDH write's
 * "TDH calculations done" event (xTDH, over-rate revocation, wave scores) is
 * published exactly once, after its generation is synced; any other write
 * gets the partial xTDH recalculation.
 */
async function announceSynced(generation: number): Promise<void> {
  if (await identityTdhSyncStateDb.claimFullAnnouncement(generation)) {
    try {
      await notifier.notifyTdhCalculationsDone();
    } catch (error) {
      await identityTdhSyncStateDb.rearmFullAnnouncement(generation);
      throw error;
    }
    logger.info(`[TDH CALCULATIONS DONE ANNOUNCED] [GENERATION ${generation}]`);
    return;
  }
  await enqueueXTdhUniverseRecalculation();
}

/**
 * Steps B to E after a committed consolidated-TDH write (step A,
 * `persistConsolidatedTDH`), each in its own short transaction:
 *
 * - B: identities from the new consolidations, profile merges, and the
 *   merged profiles' wave subscriber counts and addresses. It records the
 *   identities it wrote for C. Its unread-cache and wave-score effects run
 *   as soon as it commits.
 * - C: identity metrics, chunk by chunk (identity-metrics-sync.ts): scoped
 *   to what the pending generations changed, or a full walk
 *   (`planMetricsSync`). Each full-walk chunk records the walk's position in
 *   its own transaction, so a sync resumed for the same generation skips B
 *   and continues after the last committed chunk; a newer generation runs B
 *   and walks from the start. A stopped scoped walk is redone in full.
 * - D: TDH-based overvote revocation, against the synced identities, one
 *   transaction per candidate competition.
 * - E: TDH consumers are told (`announceSynced`), then the pending
 *   generation read at the start is marked synced, with C's ratings
 *   watermark, and its scope rows are dropped.
 *
 * B, C and D are idempotent, so a run that stops part way is finished by the
 * next call. The run stops cleanly between steps or chunks once the
 * invocation's budget is spent (`BUDGET_USED`). One run at a time holds the
 * lease; a call that finds it held leaves its generation pending.
 */
export async function syncIdentitiesAfterTdh(
  options: IdentityTdhSyncOptions = {}
): Promise<IdentityTdhSyncOutcome> {
  const { deadline, floorApplied } = resolveSyncDeadline({
    now: Time.currentMillis(),
    startedAt: invocationStartedAt,
    budgetDeadline: invocationDeadline,
    minimumSliceMs: options.minimumSliceMs ?? 0
  });
  const budgetSpent = () =>
    Time.currentMillis() >= deadline || !!options.budgetSpent?.();
  await identityTdhSyncStateDb.ensureRows();
  const owner = randomUUID();
  if (!(await identityTdhSyncStateDb.acquireLease(owner, LEASE_TTL_MS))) {
    logger.warn(
      `[LEASE HELD] [IDENTITIES SYNC LEFT PENDING FOR THE HOLDER OR NEXT RUN]`
    );
    return 'LEASE_HELD';
  }
  const lease = leaseKeeper(owner);
  try {
    const progress = await identityTdhSyncStateDb.readProgress();
    if (progress.pendingGeneration <= progress.syncedGeneration) {
      return 'UP_TO_DATE';
    }
    const generation = progress.pendingGeneration;
    const plan = await planMetricsSync(progress);
    const planLabel =
      plan.mode === 'FULL' ? `FULL WALK: ${plan.reason}` : 'SCOPED';
    if (plan.mode === 'FULL' && options.deferFullWalk) {
      logger.info(
        `[IDENTITIES SYNC LEFT FOR THE LOOP RESUME] [GENERATION ${generation}] [${planLabel}]`
      );
      return 'FULL_WALK_DEFERRED';
    }
    if (floorApplied) {
      logger.warn(
        `[IDENTITIES SYNC MINIMUM SLICE] [GENERATION ${generation}] [${planLabel}] [RUNS UNTIL ${new Date(deadline).toISOString()}, PAST THE INVOCATION BUDGET]`
      );
    }
    if (budgetSpent()) {
      logger.warn(
        `[IDENTITIES SYNC BUDGET USED] [GENERATION ${generation}] [NOT STARTED] [RESUMES NEXT INVOCATION]`
      );
      return 'BUDGET_USED';
    }
    const start = Time.now();
    logger.info(
      `[SYNCING IDENTITIES] [GENERATION ${generation}] [BLOCK ${progress.pendingBlock}] [${planLabel}]`
    );
    const walk = await identityTdhSyncStateDb.readMetricsWalk();
    let startAfter = '';
    if (walk.generation === generation) {
      // B committed for this generation before its walk started.
      startAfter = walk.after;
      logger.warn(
        `[RESUMING METRICS WALK] [GENERATION ${generation}] [B ALREADY DONE] [AFTER THE LAST COMMITTED CHUNK]`
      );
    } else {
      await syncConsolidations(generation);
      logger.info(`[B CONSOLIDATIONS DONE] [${start.diffFromNow()}]`);
      await lease.renew();
      if (
        plan.mode === 'FULL' &&
        (await canContinueFullWalk(walk, progress, generation))
      ) {
        // A newer generation does not throw away a full walk's progress:
        // the scope recheck after the walk covers what it changed behind it.
        startAfter = walk.after;
        await identityTdhSyncStateDb.continueMetricsWalk(generation);
        logger.warn(
          `[CONTINUING METRICS WALK] [GENERATION ${walk.generation} -> ${generation}] [AFTER THE LAST COMMITTED CHUNK]`
        );
      } else {
        await identityTdhSyncStateDb.startMetricsWalk(
          generation,
          RATINGS_WATERMARK_MARGIN_SECONDS
        );
      }
    }
    const chunkHooks = {
      chunkRows: options.chunkRows,
      profileIdBytes: options.profileIdBytes,
      afterSourcesLocked: options.afterSourcesLocked,
      shouldStop: budgetSpent,
      afterChunk: async (chunk: number) => {
        await lease.renewIfDue();
        await options.afterChunk?.(chunk);
      }
    };
    const metrics =
      plan.mode === 'FULL'
        ? await identityMetricsSync.syncAll({
            ...chunkHooks,
            startAfter,
            recordProgress: (last, connection) =>
              identityTdhSyncStateDb.advanceMetricsWalk(
                generation,
                last,
                connection
              )
          })
        : await syncScopedMetrics(plan, progress, generation, chunkHooks);
    if (
      !metrics.complete &&
      plan.mode === 'SCOPED' &&
      (metrics.chunks > 0 ||
        (metrics.scopeSize ?? 0) > SCOPED_WALK_MAX_IDENTITIES)
    ) {
      // Chunks ran and the scope still did not fit one budget (or it is
      // huge): walk every identity instead, which keeps a checkpoint, rather
      // than redo this scope from the start every time. A budget spent
      // before the first chunk says nothing about the scope's size.
      await identityTdhSyncScopeDb.requireFullWalk(generation);
    }
    if (!metrics.complete || budgetSpent()) {
      logger.warn(
        `[IDENTITIES SYNC BUDGET USED] [GENERATION ${generation}] [${planLabel}] [RESUMES NEXT INVOCATION] [${start.diffFromNow()}]`
      );
      return 'BUDGET_USED';
    }
    logger.info(
      `[C METRICS DONE] [${planLabel}] [ROWS ${metrics.rows}] [UPDATED ${metrics.updated}] [${start.diffFromNow()}]`
    );
    if (plan.mode === 'FULL') {
      const recheck = await recheckScopeAfterFullWalk(
        progress,
        generation,
        chunkHooks
      );
      if (!recheck.complete) {
        logger.warn(
          `[IDENTITIES SYNC BUDGET USED] [GENERATION ${generation}] [SCOPE RECHECK] [RESUMES NEXT INVOCATION]`
        );
        return 'BUDGET_USED';
      }
      if (budgetSpent()) {
        logger.warn(
          `[PROFILE ADDRESS RECONCILIATION DEFERRED] [GENERATION ${generation}] [NO BUDGET LEFT] [NEXT FULL WALK]`
        );
      } else {
        await reconcileAllProfileAddresses();
      }
    }
    // D and E are short and finish the sync even past the deadline.
    await lease.renew();
    const stepD = Time.now();
    await revokeTdhBasedDropWavesOverVotesPerCompetition();
    logger.info(
      `[D OVERVOTES DONE] [${stepD.diffFromNow()}] [${start.diffFromNow()}]`
    );
    await lease.renew();
    const stepE = Time.now();
    await announceSynced(generation);
    await identityTdhSyncStateDb.markSynced({
      generation,
      block: progress.pendingBlock,
      ratingsSince: await identityTdhSyncStateDb.readWalkRatingsSince(),
      fullWalk: plan.mode === 'FULL'
    });
    logger.info(
      `[IDENTITIES SYNCED] [GENERATION ${generation}] [E ${stepE.diffFromNow()}] [${start.diffFromNow()}]`
    );
    return 'SYNCED';
  } finally {
    await identityTdhSyncStateDb.releaseLease(owner).catch((error) => {
      logger.error(`[LEASE RELEASE FAILED] ${error}`);
    });
  }
}

/**
 * A full walk in progress for an older pending generation carries on for a
 * newer one when every generation since it recorded its scope: what those
 * changed in chunks already walked is rechecked from the scope after the
 * walk. After a full rewrite (no scope) it starts over.
 */
async function canContinueFullWalk(
  walk: { generation: number; after: string },
  progress: IdentityTdhSyncProgress,
  generation: number
): Promise<boolean> {
  if (!walk.after || walk.generation <= progress.syncedGeneration) {
    // A scoped walk (no checkpoint), or a walk of a synced generation.
    return false;
  }
  const recorded = await identityTdhSyncScopeDb.countRecordedGenerations(
    walk.generation,
    generation
  );
  return recorded === generation - walk.generation;
}

/**
 * After a full walk: the recorded scope of the pending generations again, for
 * keys and profiles a newer generation changed behind a continued walk. It is
 * small, and redundant when the walk ran for one generation.
 */
async function recheckScopeAfterFullWalk(
  progress: IdentityTdhSyncProgress,
  generation: number,
  options: Omit<
    IdentityMetricsScopedSyncOptions,
    'consolidationKeys' | 'profileIds'
  >
) {
  const scope = await identityTdhSyncScopeDb.readScope(
    progress.syncedGeneration,
    generation
  );
  if (!scope.consolidationKeys.length && !scope.profileIds.length) {
    return { complete: true };
  }
  return identityMetricsSync.syncScoped({ ...options, ...scope });
}

/**
 * With each full walk: the all-profiles address check, outside any
 * transaction, as a backstop for any writer that leaves a profile's
 * primary_wallet behind its identity (step B only checks what it touched).
 * Best effort: a failure is reported and the sync goes on.
 */
async function reconcileAllProfileAddresses(): Promise<void> {
  const start = Time.now();
  try {
    const fixed = await identitiesDb.syncAllProfileAddresses();
    logger.info(
      `[PROFILE ADDRESSES RECONCILED] [FIXED ${fixed}] [${start.diffFromNow()}]`
    );
  } catch (error) {
    logger.error(`[PROFILE ADDRESS RECONCILIATION FAILED] ${error}`);
    sentryContext.captureException(error);
  }
}

/**
 * Step B, with its cache and score effects once it commits. The identities it
 * wrote are recorded for `generation` in the same transaction, so step C
 * covers them even when it resumes in a later invocation.
 */
async function syncConsolidations(generation: number): Promise<void> {
  const invalidations = await sqlExecutor.executeNativeQueriesInTransaction(
    async (connection) => {
      const { written, ...cacheInvalidations } =
        await identityConsolidationEffects.syncIdentitiesWithTdhConsolidations(
          connection
        );
      await identityTdhSyncScopeDb.recordIdentitiesWritten(
        generation,
        written,
        connection
      );
      return cacheInvalidations;
    }
  );
  await invalidateWaveUnreadCache(invalidations);
  if (invalidations.waveIds.length) {
    await waveScoreService.requestWaveScoreRefreshBestEffort(
      invalidations.waveIds,
      WaveScoreDirtyRefreshReason.IDENTITY_CONSOLIDATION
    );
  }
}

/**
 * The sync for a loop whose other work must go on (delegations, the TDH block
 * record, the xTDH trigger): a failure is logged and sent to Sentry, and the
 * generation stays pending for the next resume, instead of failing the
 * invocation and every one after it.
 */
export async function syncIdentitiesAfterTdhOrLeavePending(
  context: 'AFTER_TDH_WRITE' | 'LOOP_RESUME',
  options: IdentityTdhSyncOptions = {}
): Promise<IdentityTdhSyncOutcome | 'LEASE_LOST' | 'FAILED'> {
  try {
    // Right after a TDH write the loop's own work is not done yet: a full
    // walk waits for the resume at the end of the invocation, which gets a
    // minimum slice however long that work took.
    return await syncIdentitiesAfterTdh({
      deferFullWalk: context === 'AFTER_TDH_WRITE',
      minimumSliceMs:
        context === 'LOOP_RESUME' ? RESUME_MINIMUM_SLICE_MS : undefined,
      ...options
    });
  } catch (error) {
    if (error instanceof IdentityTdhSyncLeaseLostError) {
      // Expected: another invocation now runs the sync. Not an alarm.
      logger.warn(
        `[IDENTITIES SYNC LEASE TAKEN OVER] [${context}] [THE NEW HOLDER CONTINUES]`
      );
      return 'LEASE_LOST';
    }
    logger.error(
      `[IDENTITIES SYNC FAILED] [${context}] [GENERATION LEFT PENDING] ${error}`
    );
    sentryContext.captureException(error);
    return 'FAILED';
  }
}

/** Also matches a TypeORM QueryFailedError wrapping the driver error. */
function isMissingTable(error: unknown): boolean {
  const candidates = [error, (error as { driverError?: unknown })?.driverError];
  return candidates.some(
    (candidate) =>
      (candidate as { code?: unknown } | null)?.code === 'ER_NO_SUCH_TABLE'
  );
}

/**
 * At the end of each delegationsLoop invocation, after its delegations work:
 * finishes an identities sync left pending by a tdhLoop full write (which
 * leaves it to delegationsLoop), a deferred full walk, a spent budget, or an
 * invocation that stopped after its TDH write. Resolves whether a pending
 * sync was resumed.
 */
export async function resumePendingIdentityTdhSync(): Promise<boolean> {
  let progress: IdentityTdhSyncProgress;
  try {
    progress = await identityTdhSyncStateDb.readProgress();
  } catch (error) {
    // Before dbMigrationsLoop creates the table nothing can be pending, and
    // the loop's other work goes on; its TDH writes fail until then.
    if (!isMissingTable(error)) throw error;
    logger.error(`[IDENTITY TDH SYNC STATE TABLE MISSING] ${error}`);
    return false;
  }
  if (progress.pendingGeneration <= progress.syncedGeneration) return false;
  logger.warn(
    `[RESUMING PENDING IDENTITIES SYNC] [GENERATION ${progress.pendingGeneration}] [SYNCED ${progress.syncedGeneration}]`
  );
  await syncIdentitiesAfterTdhOrLeavePending('LOOP_RESUME');
  return true;
}
