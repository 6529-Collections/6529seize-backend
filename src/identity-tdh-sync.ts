import { randomUUID } from 'node:crypto';
import { invalidateWaveUnreadCache } from '@/api/waves/wave-unread-cache';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from '@/api/waves/wave-score.service';
import { revokeTdhBasedDropWavesOverVotes } from '@/drops/participation-drops-over-vote-revocation';
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
import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';

const logger = Logger.get('IDENTITY_TDH_SYNC');

/** Longer than the loops' 15 minute Lambda timeout. */
const LEASE_TTL_MS = Time.minutes(16).toMillis();

export type IdentityTdhSyncOutcome = 'SYNCED' | 'UP_TO_DATE' | 'LEASE_HELD';

/**
 * Steps B to E after a committed consolidated-TDH write (step A,
 * `persistConsolidatedTDH`), each in its own short transaction:
 *
 * - B: identities from the new consolidations, profile merges, and the
 *   merged profiles' wave subscriber counts. Its unread-cache and wave-score
 *   effects run as soon as it commits.
 * - C: identity metrics, chunk by chunk (identity-metrics-sync.ts).
 * - D: TDH-based overvote revocation, against the synced identities.
 * - E: the pending generation read at the start is marked synced.
 *
 * B, C and D are idempotent, so a run that stops part way is finished by the
 * next call. One run at a time holds the lease; a call that finds it held
 * leaves its generation pending for the holder or the next invocation.
 */
export async function syncIdentitiesAfterTdh(
  options: IdentityMetricsSyncOptions = {}
): Promise<IdentityTdhSyncOutcome> {
  await identityTdhSyncStateDb.ensureRows();
  const owner = randomUUID();
  if (!(await identityTdhSyncStateDb.acquireLease(owner, LEASE_TTL_MS))) {
    logger.warn(
      `[LEASE HELD] [IDENTITIES SYNC LEFT PENDING FOR THE HOLDER OR NEXT RUN]`
    );
    return 'LEASE_HELD';
  }
  try {
    const progress = await identityTdhSyncStateDb.readProgress();
    if (progress.pendingGeneration <= progress.syncedGeneration) {
      return 'UP_TO_DATE';
    }
    const start = Time.now();
    logger.info(
      `[SYNCING IDENTITIES] [GENERATION ${progress.pendingGeneration}] [BLOCK ${progress.pendingBlock}]`
    );
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
    logger.info(`[B CONSOLIDATIONS DONE] [${start.diffFromNow()}]`);
    await identityMetricsSync.syncAll(options);
    logger.info(`[C METRICS DONE] [${start.diffFromNow()}]`);
    await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      revokeTdhBasedDropWavesOverVotes(connection)
    );
    logger.info(`[D OVERVOTES DONE] [${start.diffFromNow()}]`);
    await identityTdhSyncStateDb.markSynced(
      progress.pendingGeneration,
      progress.pendingBlock
    );
    logger.info(
      `[IDENTITIES SYNCED] [GENERATION ${progress.pendingGeneration}] [${start.diffFromNow()}]`
    );
    return 'SYNCED';
  } finally {
    await identityTdhSyncStateDb.releaseLease(owner).catch((error) => {
      logger.error(`[LEASE RELEASE FAILED] ${error}`);
    });
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
 * At loop start: finishes an identities sync left pending by an invocation
 * that stopped after its TDH write.
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
  await syncIdentitiesAfterTdh();
}
