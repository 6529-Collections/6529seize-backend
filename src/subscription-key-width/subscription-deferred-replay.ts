import {
  MEMES_CONTRACT,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE
} from '@/constants';
import { NFTFinalSubscription } from '@/entities/ISubscription';
import { Transaction } from '@/entities/ITransaction';
import { BadRequestException } from '@/exceptions';
import { sqlExecutor } from '@/sql-executor';
import {
  DeferredWriteKind,
  DeferredWriteReplayer,
  ReplayOutcome,
  ReplaySummary,
  replayDeferredSubscriptionWrites
} from './subscription-deferred-writes';

interface CardPayload {
  readonly contract: string;
  readonly token_id: number;
}

/** A refused write (the card has closed, the balance is short) is skipped. */
async function skipIfRefused(
  write: () => Promise<unknown>
): Promise<ReplayOutcome> {
  try {
    await write();
    return 'DONE';
  } catch (error) {
    if (error instanceof BadRequestException) {
      return 'SKIPPED';
    }
    throw error;
  }
}

async function cardStillUpcoming(card: CardPayload): Promise<boolean> {
  const { getMaxMemeId } = await import('@/nftsLoop/db.nfts');
  return (
    card.contract.toLowerCase() === MEMES_CONTRACT.toLowerCase() &&
    card.token_id > (await getMaxMemeId())
  );
}

async function insertFinalRow(
  row: NFTFinalSubscription
): Promise<ReplayOutcome> {
  if (!(await cardStillUpcoming(row))) {
    return 'SKIPPED';
  }
  const existing = await sqlExecutor.execute(
    `SELECT id FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
      WHERE consolidation_key = :key AND contract = :contract AND token_id = :tokenId`,
    {
      key: row.consolidation_key,
      contract: row.contract,
      tokenId: row.token_id
    }
  );
  if (existing.length) {
    return 'SKIPPED';
  }
  await sqlExecutor.execute(
    `INSERT INTO ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
      (consolidation_key, contract, token_id, subscribed_count, airdrop_address,
       balance, subscribed_at, phase, phase_subscriptions, phase_position, redeemed_count)
      VALUES (:key, :contract, :tokenId, :count, :airdrop, :balance, :subscribedAt,
       :phase, :phaseSubscriptions, :phasePosition, :redeemed)`,
    {
      key: row.consolidation_key,
      contract: row.contract,
      tokenId: row.token_id,
      count: row.subscribed_count,
      airdrop: row.airdrop_address,
      balance: row.balance,
      subscribedAt: row.subscribed_at,
      phase: row.phase ?? null,
      phaseSubscriptions: row.phase_subscriptions ?? -1,
      phasePosition: row.phase_position ?? -1,
      redeemed: row.redeemed_count ?? 0
    }
  );
  return 'DONE';
}

/**
 * Each kind's replay, through the code path that would have made the write.
 * Imports are lazy so this module adds no import cycles to the writers.
 */
export function deferredWriteReplayers(): Record<
  DeferredWriteKind,
  DeferredWriteReplayer
> {
  return {
    TOP_UP: async (write) => {
      const { persistTopUps } =
        await import('@/subscriptionsTopUpLoop/db.subscriptions_topup');
      const { topUp } = write.payload as {
        topUp: { transaction_date: string } & Record<string, unknown>;
      };
      await persistTopUps([
        {
          ...topUp,
          transaction_date: new Date(topUp.transaction_date)
        } as never
      ]);
      return 'DONE';
    },
    SUBSCRIPTION: async (write) => {
      const { updateSubscription } =
        await import('@/api/subscriptions/api.subscriptions.db');
      const p = write.payload as CardPayload & { subscribed: boolean };
      return skipIfRefused(() =>
        updateSubscription(
          write.consolidation_key,
          p.contract,
          p.token_id,
          p.subscribed
        )
      );
    },
    SUBSCRIPTION_COUNT: async (write) => {
      const { updateSubscriptionCount } =
        await import('@/api/subscriptions/api.subscriptions.db');
      const p = write.payload as CardPayload & { count: number };
      return skipIfRefused(() =>
        updateSubscriptionCount(
          write.consolidation_key,
          p.contract,
          p.token_id,
          p.count
        )
      );
    },
    MODE: async (write) => {
      const { updateSubscriptionMode } =
        await import('@/api/subscriptions/api.subscriptions.db');
      const p = write.payload as { automatic: boolean };
      return skipIfRefused(() =>
        updateSubscriptionMode(write.consolidation_key, p.automatic)
      );
    },
    ALL_EDITIONS: async (write) => {
      const { updateSubscribeAllEditions } =
        await import('@/api/subscriptions/api.subscriptions.db');
      const p = write.payload as { subscribe_all_editions: boolean };
      return skipIfRefused(() =>
        updateSubscribeAllEditions(
          write.consolidation_key,
          p.subscribe_all_editions
        )
      );
    },
    AUTO_SUBSCRIPTION: async (write) => {
      const row = write.payload as CardPayload & Record<string, unknown>;
      if (!(await cardStillUpcoming(row))) {
        return 'SKIPPED';
      }
      const { persistSubscriptions } =
        await import('@/subscriptionsDaily/db.subscriptions');
      await persistSubscriptions([row as never], []);
      return 'DONE';
    },
    FINAL_ROW: async (write) =>
      insertFinalRow(write.payload as NFTFinalSubscription),
    LOG: async (write) => {
      const log = write.payload as {
        log: string;
        additional_info?: string | null;
      };
      await sqlExecutor.execute(
        `INSERT INTO ${SUBSCRIPTIONS_LOGS_TABLE} (consolidation_key, log, additional_info)
          VALUES (:key, :log, :info)`,
        {
          key: write.consolidation_key,
          log: log.log,
          info: log.additional_info ?? null
        }
      );
      return 'DONE';
    },
    REDEMPTION: async (write) => {
      const { redeemDeferredToken } =
        await import('@/transactionsProcessingLoop/subscriptions');
      const { transaction } = write.payload as { transaction: Transaction };
      await redeemDeferredToken(transaction);
      return 'DONE';
    },
    CONSOLIDATION: async (write) => {
      const { consolidateSubscriptions } =
        await import('@/subscriptionsDaily/subscriptions');
      const { newKey } = write.payload as { newKey: string };
      await consolidateSubscriptions(new Set(newKey.split('-')));
      return 'DONE';
    }
  };
}

/** Replays every queued write whose key now fits, with the real writers. */
export function replayDeferredSubscriptionWritesNow(): Promise<ReplaySummary> {
  return replayDeferredSubscriptionWrites(deferredWriteReplayers());
}
