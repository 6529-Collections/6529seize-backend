import {
  MEMES_CONTRACT,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE
} from '@/constants';
import {
  NFTFinalSubscription,
  NFTSubscription,
  SubscriptionLog,
  SubscriptionTopUp
} from '@/entities/ISubscription';
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

const insertFinalRow: DeferredWriteReplayer = (entry) => {
  const row = entry.payload as NFTFinalSubscription;
  return inTransaction(
    entry.sequence,
    async (sink) =>
      (await cardStillUpcoming(row.contract, row.token_id)) &&
      !(await rowExists(sink, SUBSCRIPTIONS_NFTS_FINAL_TABLE, row))
        ? 'DONE'
        : 'SKIPPED',
    async (sink) => {
      await sink.query(
        `INSERT INTO ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
          (consolidation_key, contract, token_id, subscribed_count, airdrop_address,
           balance, subscribed_at, phase, phase_subscriptions, phase_position, redeemed_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.consolidation_key,
          row.contract,
          row.token_id,
          row.subscribed_count,
          row.airdrop_address,
          row.balance,
          row.subscribed_at,
          row.phase ?? null,
          row.phase_subscriptions ?? -1,
          row.phase_position ?? -1,
          row.redeemed_count ?? 0
        ]
      );
    }
  );
};

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

const insertLog: DeferredWriteReplayer = (entry) => {
  const log = entry.payload as SubscriptionLog;
  return inTransaction(
    entry.sequence,
    async () => 'DONE',
    async (sink) => {
      await sink.query(
        `INSERT INTO ${SUBSCRIPTIONS_LOGS_TABLE} (consolidation_key, log, additional_info)
          VALUES (?, ?, ?)`,
        [log.consolidation_key, log.log, log.additional_info ?? null]
      );
    }
  );
};

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
  FINAL_ROW: insertFinalRow,
  LOG: insertLog,
  CONSOLIDATION: replayConsolidation
};

/** Replays every queued write the top-up loop owns whose key now fits. */
export function replayTopUpLoopDeferredWrites(): Promise<ReplaySummary> {
  return replayDeferredSubscriptionWrites(TOP_UP_LOOP_REPLAYERS);
}
