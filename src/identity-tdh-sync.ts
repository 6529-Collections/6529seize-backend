import { randomUUID } from 'node:crypto';
import { invalidateWaveUnreadCache } from '@/api/waves/wave-unread-cache';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from '@/api/waves/wave-score.service';
import { revokeTdhBasedDropWavesOverVotesPerCompetition } from '@/drops/participation-drops-over-vote-revocation';
import { identityConsolidationEffects } from '@/identity';
import {
  identityMetricsSync,
  IdentityMetricsSyncOptions
} from '@/identity-metrics-sync';
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
  | 'BUDGET_USED';

/**
 * Identities sync time per delegationsLoop invocation. The sync stops cleanly
 * between chunks once it is spent and the next invocation resumes it, so no
 * invocation nears the 900 s Lambda timeout however cold the pages are.
 */
const IDENTITY_SYNC_BUDGET_MS = Time.minutes(5).toMillis();
let invocationDeadline: number | null = null;

/** At invocation start: the syncs of this invocation share one budget. */
export function startIdentitySyncBudget(
  budgetMs: number = IDENTITY_SYNC_BUDGET_MS
): void {
  invocationDeadline = Time.currentMillis() + budgetMs;
}

export type IdentityTdhSyncOptions = IdentityMetricsSyncOptions & {
  /** Test hook: also stops the run, as a spent budget does. */
  readonly budgetSpent?: () => boolean;
};

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
 *   merged profiles' wave subscriber counts. Its unread-cache and wave-score
 *   effects run as soon as it commits.
 * - C: identity metrics, chunk by chunk (identity-metrics-sync.ts). Each
 *   chunk records the walk's position in its own transaction, so a sync
 *   resumed for the same generation skips B and continues after the last
 *   committed chunk; a newer generation runs B and walks from the start.
 * - D: TDH-based overvote revocation, against the synced identities, one
 *   transaction per candidate competition.
 * - E: TDH consumers are told (`announceSynced`), then the pending
 *   generation read at the start is marked synced.
 *
 * B, C and D are idempotent, so a run that stops part way is finished by the
 * next call. The run stops cleanly between steps or chunks once the
 * invocation's budget is spent (`BUDGET_USED`). One run at a time holds the
 * lease; a call that finds it held leaves its generation pending.
 */
export async function syncIdentitiesAfterTdh(
  options: IdentityTdhSyncOptions = {}
): Promise<IdentityTdhSyncOutcome> {
  const deadline =
    invocationDeadline ?? Time.currentMillis() + IDENTITY_SYNC_BUDGET_MS;
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
    const start = Time.now();
    logger.info(
      `[SYNCING IDENTITIES] [GENERATION ${generation}] [BLOCK ${progress.pendingBlock}]`
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
      await syncConsolidations();
      logger.info(`[B CONSOLIDATIONS DONE] [${start.diffFromNow()}]`);
      await lease.renew();
      await identityTdhSyncStateDb.startMetricsWalk(generation);
    }
    const metrics = await identityMetricsSync.syncAll({
      ...options,
      startAfter,
      shouldStop: budgetSpent,
      recordProgress: (last, connection) =>
        identityTdhSyncStateDb.advanceMetricsWalk(generation, last, connection),
      afterChunk: async (chunk) => {
        await lease.renewIfDue();
        await options.afterChunk?.(chunk);
      }
    });
    if (!metrics.complete || budgetSpent()) {
      logger.warn(
        `[IDENTITIES SYNC BUDGET USED] [GENERATION ${generation}] [RESUMES NEXT INVOCATION] [${start.diffFromNow()}]`
      );
      return 'BUDGET_USED';
    }
    logger.info(`[C METRICS DONE] [${start.diffFromNow()}]`);
    await lease.renew();
    await revokeTdhBasedDropWavesOverVotesPerCompetition();
    logger.info(`[D OVERVOTES DONE] [${start.diffFromNow()}]`);
    await lease.renew();
    await announceSynced(generation);
    await identityTdhSyncStateDb.markSynced(generation, progress.pendingBlock);
    logger.info(
      `[IDENTITIES SYNCED] [GENERATION ${generation}] [${start.diffFromNow()}]`
    );
    return 'SYNCED';
  } finally {
    await identityTdhSyncStateDb.releaseLease(owner).catch((error) => {
      logger.error(`[LEASE RELEASE FAILED] ${error}`);
    });
  }
}

/** Step B, with its cache and score effects once it commits. */
async function syncConsolidations(): Promise<void> {
  const invalidations = await sqlExecutor.executeNativeQueriesInTransaction(
    (connection) =>
      identityConsolidationEffects.syncIdentitiesWithTdhConsolidations(
        connection
      )
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
 * generation stays pending for the next loop start, instead of failing the
 * invocation and every one after it.
 */
export async function syncIdentitiesAfterTdhOrLeavePending(
  context: 'AFTER_TDH_WRITE' | 'LOOP_START',
  options: IdentityTdhSyncOptions = {}
): Promise<IdentityTdhSyncOutcome | 'LEASE_LOST' | 'FAILED'> {
  try {
    return await syncIdentitiesAfterTdh(options);
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
 * At delegationsLoop start: finishes an identities sync left pending by a
 * tdhLoop full write (which leaves it to delegationsLoop), a spent budget, or
 * an invocation that stopped after its TDH write.
 */
export async function resumePendingIdentityTdhSync(): Promise<void> {
  let progress: IdentityTdhSyncProgress;
  try {
    progress = await identityTdhSyncStateDb.readProgress();
  } catch (error) {
    // Before dbMigrationsLoop creates the table nothing can be pending, and
    // the loop's other work goes on; its TDH writes fail until then.
    if (!isMissingTable(error)) throw error;
    logger.error(`[IDENTITY TDH SYNC STATE TABLE MISSING] ${error}`);
    return;
  }
  if (progress.pendingGeneration <= progress.syncedGeneration) return;
  logger.warn(
    `[RESUMING PENDING IDENTITIES SYNC] [GENERATION ${progress.pendingGeneration}] [SYNCED ${progress.syncedGeneration}]`
  );
  await syncIdentitiesAfterTdhOrLeavePending('LOOP_START');
}
