import { MEMES_CONTRACT, SUBSCRIPTIONS_NFTS_TABLE } from '@/constants';
import { NFTSubscription, SubscriptionTopUp } from '@/entities/ISubscription';
import { sqlExecutor } from '@/sql-executor';
import {
  claimDeferredWrite,
  DeferredWriteKind,
  DeferredWriteReplayer,
  DeferredWriteSink,
  executorSink,
  ReplayOutcome,
  ReplaySummary,
  replayDeferredSubscriptionWrites
} from './subscription-deferred-writes';

async function cardStillUpcoming(contract: string, tokenId: number) {
  const { getMaxMemeId } = await import('@/nftsLoop/db.nfts');
  return (
    contract.toLowerCase() === MEMES_CONTRACT.toLowerCase() &&
    tokenId > (await getMaxMemeId())
  );
}

async function rowExists(
  sink: DeferredWriteSink,
  table: string,
  row: { consolidation_key: string; contract: string; token_id: number }
): Promise<boolean> {
  const rows = (await sink.query(
    `SELECT 1 AS present FROM ${table}
      WHERE consolidation_key = ? AND contract = ? AND token_id = ?`,
    [row.consolidation_key, row.contract, row.token_id]
  )) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Decides and makes one write in one transaction with the queue entry's
 * claim: a write that no longer applies is claimed as SKIPPED and not made.
 */
function inTransaction(
  sequence: number,
  decide: (sink: DeferredWriteSink) => Promise<ReplayOutcome>,
  write: (sink: DeferredWriteSink) => Promise<void>
): Promise<ReplayOutcome | null> {
  return sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const sink = executorSink({ wrappedConnection: connection });
    const outcome = await decide(sink);
    if (!(await claimDeferredWrite(sequence, outcome, sink))) {
      return null;
    }
    if (outcome === 'DONE') {
      await write(sink);
    }
    return outcome;
  });
}

/**
 * A final-list row is never inserted as it stood at the build: the balance
 * or the list may have moved since. The entry is claimed as SKIPPED and the
 * next daily build, which rebuilds the card's list, decides.
 */
const skipFinalRow: DeferredWriteReplayer = (entry) =>
  inTransaction(
    entry.sequence,
    async () => 'SKIPPED',
    async () => undefined
  );

const insertAutomaticRow: DeferredWriteReplayer = (entry) => {
  const row = entry.payload as NFTSubscription;
  return inTransaction(
    entry.sequence,
    async (sink) =>
      (await cardStillUpcoming(row.contract, row.token_id)) &&
      !(await rowExists(sink, SUBSCRIPTIONS_NFTS_TABLE, row))
        ? 'DONE'
        : 'SKIPPED',
    async (sink) => {
      await sink.query(
        `INSERT INTO ${SUBSCRIPTIONS_NFTS_TABLE}
          (consolidation_key, contract, token_id, subscribed, subscribed_count, automatic_subscription)
          VALUES (?, ?, ?, ?, ?, ?)`,
        [
          row.consolidation_key,
          row.contract,
          row.token_id,
          row.subscribed,
          row.subscribed_count,
          row.automatic_subscription
        ]
      );
    }
  );
};

/**
 * Every queued log line is a daily-build line (an automatic row's, or a
 * final-list decision's). The next build writes fresh ones, and a line for
 * a final row that is never inserted ("Added to Final Subscription") would
 * be false, so the entry is claimed as SKIPPED and nothing is written.
 */
const skipLog: DeferredWriteReplayer = (entry) =>
  inTransaction(
    entry.sequence,
    async () => 'SKIPPED',
    async () => undefined
  );

const replayTopUp: DeferredWriteReplayer = async (entry) => {
  const { persistTopUps } =
    await import('@/subscriptionsTopUpLoop/db.subscriptions_topup');
  const { topUp } = entry.payload as {
    topUp: Omit<SubscriptionTopUp, 'transaction_date'> & {
      transaction_date: string;
    };
  };
  const claimed = await persistTopUps(
    [{ ...topUp, transaction_date: new Date(topUp.transaction_date) }],
    { replaySequence: entry.sequence }
  );
  return claimed ? 'DONE' : null;
};

const replayConsolidation: DeferredWriteReplayer = async (entry) => {
  const { consolidateSubscriptions } =
    await import('@/subscriptionsDaily/subscriptions');
  const { newKey } = entry.payload as { newKey: string };
  const claimed = await consolidateSubscriptions(new Set(newKey.split('-')), {
    replaySequence: entry.sequence
  });
  return claimed ? 'DONE' : null;
};

/**
 * The top-up loop's replays. Redemptions are replayed by the transactions
 * loop, inside its own redemption transaction.
 */
const TOP_UP_LOOP_REPLAYERS: Partial<
  Record<DeferredWriteKind, DeferredWriteReplayer>
> = {
  TOP_UP: replayTopUp,
  AUTO_SUBSCRIPTION: insertAutomaticRow,
  FINAL_ROW: skipFinalRow,
  LOG: skipLog,
  CONSOLIDATION: replayConsolidation
};

/** Replays every queued write the top-up loop owns whose key now fits. */
export function replayTopUpLoopDeferredWrites(): Promise<ReplaySummary> {
  return replayDeferredSubscriptionWrites(TOP_UP_LOOP_REPLAYERS);
}
