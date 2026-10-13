import { Logger } from '@/logging';
import { Time } from '@/time';

const logger = Logger.get('MARKET_DEPTH_RETENTION');

// Order-book activity (listings, offers, cancellations, invalidations...) is
// purged after this window and hidden from the activity feed. On-chain sales
// and transfers come from the transactions table and are unaffected.
export const MARKET_DEPTH_EVENT_RETENTION_DAYS = 30;
// Snapshot archives are kept for debugging. The latest snapshot per
// collection and any snapshot still referenced by the live book are kept.
export const MARKET_DEPTH_SNAPSHOT_RETENTION_DAYS = 14;
// Resolved rows, and unresolved rows overdue for this long, are dropped.
export const MARKET_DEPTH_RECONCILIATION_RETENTION_DAYS = 7;

export const MARKET_DEPTH_EVENT_PURGE_BATCH_SIZE = 1_000;
export const MARKET_DEPTH_RECONCILIATION_PURGE_BATCH_SIZE = 1_000;
export const MARKET_DEPTH_SNAPSHOT_PURGE_BATCH_SIZE = 20;
// Bounds each table's deletes per run so a backlog drains over several runs
// instead of saturating storage IO and binlog volume in one invocation.
const MAX_ROWS_PER_TABLE_PER_RUN = 100_000;
const BATCH_PAUSE_MS = 100;

export function marketDepthEventRetentionCutoff(now: Date): Date {
  return new Date(
    now.getTime() - Time.days(MARKET_DEPTH_EVENT_RETENTION_DAYS).toMillis()
  );
}

export interface MarketDepthEventPurgeKey {
  observed_at: Date;
  event_id: string;
}

export interface MarketDepthEventPurgeBatch {
  // Rows examined, including events kept because their order is still live.
  scanned: number;
  deleted: number;
  last: MarketDepthEventPurgeKey | null;
}

export interface MarketDepthRetentionDb {
  purgeEventsObservedBefore(input: {
    contract: string;
    cutoff: Date;
    after: MarketDepthEventPurgeKey | null;
    limit: number;
  }): Promise<MarketDepthEventPurgeBatch>;
  purgeReconciliationsDueBefore(input: {
    contract: string;
    cutoff: Date;
    limit: number;
  }): Promise<number>;
  purgeSnapshotsCompletedBefore(input: {
    contract: string;
    cutoff: Date;
    limit: number;
  }): Promise<number>;
}

export interface MarketDepthRetentionResult {
  snapshots: number;
  reconciliations: number;
  events: number;
  complete: boolean;
}

interface PurgeLoopOptions {
  readonly deadlineMs: number;
  readonly now: () => Date;
  readonly pause: (ms: number) => Promise<void>;
}

async function purgeInBatches(
  batch: () => Promise<{ deleted: number; exhausted: boolean }>,
  options: PurgeLoopOptions
): Promise<{ deleted: number; complete: boolean }> {
  let deleted = 0;
  while (
    options.now().getTime() < options.deadlineMs &&
    deleted < MAX_ROWS_PER_TABLE_PER_RUN
  ) {
    const result = await batch();
    deleted += result.deleted;
    if (result.exhausted) return { deleted, complete: true };
    await options.pause(BATCH_PAUSE_MS);
  }
  return { deleted, complete: false };
}

export async function purgeMarketDepthHistory(input: {
  readonly contract: string;
  readonly deadlineMs: number;
  readonly db: MarketDepthRetentionDb;
  readonly now?: () => Date;
  readonly pause?: (ms: number) => Promise<void>;
}): Promise<MarketDepthRetentionResult> {
  const now = input.now ?? (() => new Date());
  const options: PurgeLoopOptions = {
    deadlineMs: input.deadlineMs,
    now,
    pause: input.pause ?? ((ms) => Time.millis(ms).sleep())
  };
  const contract = input.contract.toLowerCase();
  const startedAt = now();

  const snapshotCutoff = new Date(
    startedAt.getTime() -
      Time.days(MARKET_DEPTH_SNAPSHOT_RETENTION_DAYS).toMillis()
  );
  const snapshots = await purgeInBatches(async () => {
    const deleted = await input.db.purgeSnapshotsCompletedBefore({
      contract,
      cutoff: snapshotCutoff,
      limit: MARKET_DEPTH_SNAPSHOT_PURGE_BATCH_SIZE
    });
    return {
      deleted,
      exhausted: deleted < MARKET_DEPTH_SNAPSHOT_PURGE_BATCH_SIZE
    };
  }, options);

  const reconciliationCutoff = new Date(
    startedAt.getTime() -
      Time.days(MARKET_DEPTH_RECONCILIATION_RETENTION_DAYS).toMillis()
  );
  const reconciliations = await purgeInBatches(async () => {
    const deleted = await input.db.purgeReconciliationsDueBefore({
      contract,
      cutoff: reconciliationCutoff,
      limit: MARKET_DEPTH_RECONCILIATION_PURGE_BATCH_SIZE
    });
    return {
      deleted,
      exhausted: deleted < MARKET_DEPTH_RECONCILIATION_PURGE_BATCH_SIZE
    };
  }, options);

  const eventCutoff = marketDepthEventRetentionCutoff(startedAt);
  let after: MarketDepthEventPurgeKey | null = null;
  const events = await purgeInBatches(async () => {
    const batch = await input.db.purgeEventsObservedBefore({
      contract,
      cutoff: eventCutoff,
      after,
      limit: MARKET_DEPTH_EVENT_PURGE_BATCH_SIZE
    });
    after = batch.last;
    return {
      deleted: batch.deleted,
      exhausted: batch.scanned < MARKET_DEPTH_EVENT_PURGE_BATCH_SIZE
    };
  }, options);

  const result: MarketDepthRetentionResult = {
    snapshots: snapshots.deleted,
    reconciliations: reconciliations.deleted,
    events: events.deleted,
    complete: snapshots.complete && reconciliations.complete && events.complete
  };
  logger.info(
    `[CONTRACT ${contract}] Market-depth retention ${JSON.stringify(result)}`
  );
  return result;
}
