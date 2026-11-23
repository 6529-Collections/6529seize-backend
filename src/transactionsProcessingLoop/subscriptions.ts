import { EntityManager } from 'typeorm';
import { DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES } from '@/airdrop-phases';
import {
  DISTRIBUTION_TABLE,
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  NULL_ADDRESS,
  RESEARCH_6529_ADDRESS,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { fetchMaxTransactionByBlockNumber, getDataSource } from '../db';
import {
  NFTFinalSubscription,
  RedeemedSubscription
} from '../entities/ISubscription';
import { Transaction } from '../entities/ITransaction';
import { TransactionsProcessedSubscriptionsBlock } from '../entities/ITransactionsProcessing';
import { ethTools } from '../eth-tools';
import { Logger } from '../logging';
import {
  sendInsufficientBalanceWaveError,
  sendNoBalanceFoundWaveError,
  sendNoSubscriptionFoundWaveWarning
} from '../subscription-wave-notifier';
import { sqlExecutor } from '../sql-executor';
import { equalIgnoreCase } from '../strings';
import {
  lockSubscriptionBalance,
  writeSubscriptionBalance
} from '../subscriptionsDaily/db.subscriptions';
import {
  getLastProcessingBlock,
  persistBlock
} from './db.transactions_processing';
import { markSubscriptionCoverageDirty } from '../subscription-coverage/subscription-coverage-dirty';
import {
  claimDeferredWrite,
  deferralReason,
  deferSubscriptionWrites,
  replayDeferredSubscriptionWrites
} from '@/subscription-key-width/subscription-deferred-writes';
import { appFeatures } from '@/app-features';

const logger = Logger.get('TRANSACTIONS_PROCESSING_SUBSCRIPTIONS');

type SubscriptionWaveNotification =
  | {
      kind: 'no-subscription-found';
      airdropAddress: string;
      transactionLink: string;
    }
  | {
      kind: 'no-balance-found';
      consolidationKey: string;
      transactionLink: string;
    }
  | {
      kind: 'insufficient-balance';
      consolidationKey: string;
      transactionLink: string;
    };

export const redeemSubscriptions = async (reset?: boolean) => {
  if (appFeatures.isSubscriptionDeferredReplayEnabled()) {
    await replayDeferredRedemptions();
  }
  const blockRepo = getDataSource().getRepository(
    TransactionsProcessedSubscriptionsBlock
  );
  const lastProcessingBlock = await getLastProcessingBlock(blockRepo, reset);
  // The memes contract's highest block, not the highest of all contracts.
  // The memes transactions loop commits whole blocks, in block order, so
  // every memes airdrop up to this block is already in the table. The
  // gradients and memelab loops keep their own cursors and can be ahead.
  // Recording their block skipped any memes airdrop the memes loop then
  // committed in a lower block: it was never charged.
  const maxBlockTransaction =
    await fetchMaxTransactionByBlockNumber(MEMES_CONTRACT);

  if (!maxBlockTransaction) {
    throw new Error('No max transaction block');
  }

  if (!lastProcessingBlock) {
    logger.info(
      `[NO STARTING BLOCK] : [SETTING TO MAX TRANSACTION BLOCK ${maxBlockTransaction.block}]`
    );
    await persistBlock(blockRepo, maxBlockTransaction);
    return;
  }
  // Only up to the block this run records as processed: an airdrop the
  // memes loop commits in a later block after the read above is left
  // to the next run, which starts after that block. Unbounded, it was
  // charged now and again by the next run.
  const airdrops: Transaction[] = await sqlExecutor.execute(
    `SELECT * FROM ${TRANSACTIONS_TABLE}
    WHERE block > :lastProcessingBlock
    AND block <= :maxBlock
    AND from_address = :nullAddress
    AND value = 0
    AND token_count > 0
    ORDER BY block asc;`,
    {
      lastProcessingBlock,
      maxBlock: maxBlockTransaction.block,
      nullAddress: NULL_ADDRESS
    }
  );

  if (airdrops.length === 0) {
    logger.info(`[NO AIRDROPS TO PROCESS]`);
    await persistBlock(blockRepo, maxBlockTransaction);
    logger.info(`[BLOCK ${maxBlockTransaction.block} PERSISTED]`);
    return;
  }

  logger.info(`[${airdrops.length} AIRDROPS TO PROCESS]`);

  const waveNotifications: SubscriptionWaveNotification[] = [];
  const dirtyConsolidationKeys = new Set<string>();
  await getDataSource().transaction(async (entityManager) => {
    for (const drop of airdrops) {
      await processAirdrop(
        drop,
        entityManager,
        waveNotifications,
        dirtyConsolidationKeys
      );
    }
    const transactionBlockRepo = entityManager.getRepository(
      TransactionsProcessedSubscriptionsBlock
    );
    await persistBlock(transactionBlockRepo, maxBlockTransaction);
    logger.info(`[BLOCK ${maxBlockTransaction.block} PERSISTED]`);
  });

  await markSubscriptionCoverageDirty(
    Array.from(dirtyConsolidationKeys),
    'SUBSCRIPTION_REDEEMED'
  );
  await sendSubscriptionWaveNotifications(waveNotifications);
};

export async function processAirdrop(
  transaction: Transaction,
  entityManager: EntityManager,
  waveNotifications: SubscriptionWaveNotification[] = [],
  dirtyConsolidationKeys?: Set<string>
): Promise<void> {
  const validation = await validateNonSubscriptionAirdrop(
    transaction,
    entityManager
  );

  if (validation.valid) {
    return;
  }

  for (let i = 0; i < transaction.token_count; i++) {
    await processSubscription(
      transaction,
      entityManager,
      waveNotifications,
      dirtyConsolidationKeys,
      { tokenIndex: i }
    );
  }
}

export async function validateNonSubscriptionAirdrop(
  transaction: Transaction,
  entityManager: EntityManager
): Promise<{ valid: boolean; message: string }> {
  if (!equalIgnoreCase(MEMES_CONTRACT, transaction.contract)) {
    const message = 'Not memes contract';
    logger.info(
      `[SKIPPING: ${message}] : [CONTRACT ${transaction.contract}] : [Transaction ${transaction.transaction}]`
    );
    return {
      valid: true,
      message
    };
  } else {
    logger.info(
      `[PROCESSING AIRDROP] : [Transaction ${transaction.transaction}]`
    );
  }

  if (equalIgnoreCase(RESEARCH_6529_ADDRESS, transaction.to_address)) {
    const message = 'Airdrop to research';
    logger.info(
      `[SKIPPING TRANSACTION] : [${message}] : [Transaction ${transaction.transaction}]`
    );
    return {
      valid: true,
      message
    };
  }

  const distributionAirdrop = (
    await entityManager.query(
      `SELECT COALESCE(SUM(count), 0) as count FROM ${DISTRIBUTION_TABLE} 
        WHERE LOWER(wallet) = ?
        AND LOWER(phase) IN (${DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES.map(() => '?').join(', ')})
        AND LOWER(contract) = ?
        AND card_id = ?;`,
      [
        transaction.to_address.toLowerCase(),
        ...DISTRIBUTION_AUTOMATIC_AIRDROP_PHASES.map((phase) =>
          phase.toLowerCase()
        ),
        transaction.contract.toLowerCase(),
        transaction.token_id
      ]
    )
  )[0];

  const distributionAirdropCount = Number(distributionAirdrop?.count ?? 0);
  if (distributionAirdropCount > 0) {
    const previousAirdrops = (
      await entityManager.query(
        `SELECT SUM(token_count) as previous_airdrops FROM ${TRANSACTIONS_TABLE}
        WHERE contract = ?
        AND token_id = ?
        AND from_address = ?
        AND LOWER(to_address) = LOWER(?)
        AND block < ?
        AND value = 0;`,
        [
          transaction.contract,
          transaction.token_id,
          NULL_ADDRESS,
          transaction.to_address,
          transaction.block
        ]
      )
    )[0].previous_airdrops;
    // MySQL returns SUM as a decimal string, or NULL with no earlier
    // airdrop. Added as a string, "1" + 1 made "11", so a distribution
    // airdrop that followed an earlier airdrop of the card to the same wallet
    // was taken for a subscription airdrop.
    if (
      distributionAirdropCount >=
      Number(previousAirdrops ?? 0) + transaction.token_count
    ) {
      const message = 'Distribution airdrop';
      logger.info(
        `[SKIPPING TRANSACTION] : [${message}] : [Transaction ${transaction.transaction}]`
      );
      return {
        valid: true,
        message
      };
    }
  }

  return {
    valid: false,
    message: 'Subscription airdrop'
  };
}

interface RedemptionOptions {
  /** Which token of the transaction this is, from 0. */
  readonly tokenIndex: number;
  /** For a replayed token: only writes queued before it hold it back. */
  readonly beforeSequence?: number;
}

async function processSubscription(
  transaction: Transaction,
  entityManager: EntityManager,
  waveNotifications: SubscriptionWaveNotification[],
  dirtyConsolidationKeys: Set<string> | undefined,
  options: RedemptionOptions
) {
  // FOR UPDATE: a merge moves final allocations and their balances to the
  // new key in one transaction. Locked, the allocation is read only after
  // such a merge commits, with its current key, so the charge below goes to
  // the balance the merge left. This locks the card's allocations that the
  // read scans until the run commits.
  const finalSubscription: NFTFinalSubscription | undefined = (
    await entityManager.query(
      `SELECT * FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
      WHERE ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.contract = ?
      AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.token_id = ?
      AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.airdrop_address = ?
      AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.redeemed_count < ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.subscribed_count
      ORDER BY phase ASC, phase_position ASC
      FOR UPDATE;`,
      [transaction.contract, transaction.token_id, transaction.to_address]
    )
  )[0];

  if (!finalSubscription) {
    const transactionLink = buildTransactionLink(transaction.transaction);
    const message = `🚨 No subscription found for airdrop address: ${transaction.to_address} \nTransaction: ${transactionLink}`;
    logger.errorWithCode('SUBSCRIPTION_NOT_FOUND', message);
    waveNotifications.push({
      kind: 'no-subscription-found',
      airdropAddress: transaction.to_address,
      transactionLink
    });
    return;
  }

  // The key whose balance pays: the allocation's, or the key a merge moved
  // that balance to when the merge left this allocation under the old key.
  const locked = await lockSubscriptionBalance(
    finalSubscription.consolidation_key,
    entityManager
  );
  const payingKey = locked.consolidationKey;

  // The key-width guard runs on the key the charge is written to.
  if (await deferRedemption(transaction, payingKey, entityManager, options)) {
    return;
  }

  let balance = locked.balance;
  if (!balance) {
    const transactionLink = buildTransactionLink(transaction.transaction);
    const message = `🚨 No balance found for consolidation key: ${payingKey} \nTransaction: ${transactionLink}`;
    logger.errorWithCode('SUBSCRIPTION_BALANCE_NOT_FOUND', message);
    waveNotifications.push({
      kind: 'no-balance-found',
      consolidationKey: payingKey,
      transactionLink
    });
    balance = {
      consolidation_key: payingKey,
      balance: 0
    };
  } else if (MEMES_MINT_PRICE > balance.balance) {
    const transactionLink = buildTransactionLink(transaction.transaction);
    const message = `🚨 Insufficient balance for consolidation key: ${payingKey} \nTransaction: ${transactionLink}`;
    logger.errorWithCode('SUBSCRIPTION_BALANCE_INSUFFICIENT', message);
    waveNotifications.push({
      kind: 'insufficient-balance',
      consolidationKey: payingKey,
      transactionLink
    });
  }

  let balanceAfter = balance.balance - MEMES_MINT_PRICE;
  balanceAfter = Math.round(balanceAfter * 100000) / 100000;
  balance.balance = balanceAfter;

  await writeSubscriptionBalance(
    entityManager,
    balance,
    locked.balance !== null
  );

  const existingRedeemed = await entityManager
    .getRepository(RedeemedSubscription)
    .findOne({
      where: {
        contract: transaction.contract,
        token_id: transaction.token_id,
        address: transaction.to_address,
        transaction: transaction.transaction,
        consolidation_key: payingKey
      }
    });

  if (existingRedeemed) {
    existingRedeemed.value += MEMES_MINT_PRICE;
    existingRedeemed.count++;
    existingRedeemed.balance_after = balanceAfter;
    await entityManager
      .getRepository(RedeemedSubscription)
      .save(existingRedeemed);
  } else {
    const redeemedSubscription: RedeemedSubscription = {
      contract: transaction.contract,
      token_id: transaction.token_id,
      address: transaction.to_address,
      transaction: transaction.transaction,
      transaction_date: transaction.transaction_date,
      consolidation_key: payingKey,
      value: MEMES_MINT_PRICE,
      balance_after: balanceAfter,
      count: 1
    };

    await entityManager
      .getRepository(RedeemedSubscription)
      .save(redeemedSubscription);
  }

  finalSubscription.redeemed_count++;
  await entityManager
    .getRepository(NFTFinalSubscription)
    .save(finalSubscription);
  dirtyConsolidationKeys?.add(payingKey);
}

/**
 * A redemption whose key must wait (too long for a subscription table, or
 * with earlier writes waiting) is queued whole, one token per entry: no
 * balance change, no redeemed row and no redeemed count until it is
 * replayed.
 */
async function deferRedemption(
  transaction: Transaction,
  consolidationKey: string,
  entityManager: EntityManager,
  options: RedemptionOptions
): Promise<boolean> {
  const reason = await deferralReason(
    consolidationKey,
    entityManager,
    options.beforeSequence,
    { locking: true }
  );
  if (!reason) {
    return false;
  }
  await deferSubscriptionWrites(
    [
      {
        kind: 'REDEMPTION',
        consolidationKey,
        dedupe: [
          transaction.transaction,
          transaction.to_address,
          transaction.contract,
          transaction.token_id,
          options.tokenIndex
        ]
          .join('|')
          .toLowerCase(),
        payload: { transaction, tokenIndex: options.tokenIndex },
        reason
      }
    ],
    entityManager
  );
  return true;
}

/**
 * Replays queued redemption tokens whose key now fits, in queue order. Each
 * token is matched and charged by the normal path and its queue entry is
 * claimed in the same transaction, so a token is charged once.
 */
async function replayDeferredRedemptions(): Promise<void> {
  const waveNotifications: SubscriptionWaveNotification[] = [];
  const dirtyConsolidationKeys = new Set<string>();
  try {
    const summary = await replayDeferredSubscriptionWrites({
      REDEMPTION: async (write) => {
        const { transaction, tokenIndex } = write.payload as {
          transaction: Transaction;
          tokenIndex: number;
        };
        // This token's notices and dirty keys count only once its
        // transaction has committed.
        const notices: SubscriptionWaveNotification[] = [];
        const dirty = new Set<string>();
        const outcome = await getDataSource().transaction(
          async (entityManager) => {
            if (
              !(await claimDeferredWrite(write.sequence, 'DONE', entityManager))
            ) {
              return null;
            }
            await processSubscription(
              transaction,
              entityManager,
              notices,
              dirty,
              {
                tokenIndex,
                beforeSequence: write.sequence
              }
            );
            return 'DONE' as const;
          }
        );
        waveNotifications.push(...notices);
        dirty.forEach((key) => dirtyConsolidationKeys.add(key));
        return outcome;
      }
    });
    if (summary.done || summary.requeued || summary.failed) {
      logger.info(`[DEFERRED REDEMPTIONS REPLAYED] ${JSON.stringify(summary)}`);
    }
  } catch (error) {
    logger.error('[DEFERRED REDEMPTIONS REPLAY FAILED]', error);
  }
  await markSubscriptionCoverageDirty(
    Array.from(dirtyConsolidationKeys),
    'SUBSCRIPTION_REDEEMED'
  );
  await sendSubscriptionWaveNotifications(waveNotifications);
}

function buildTransactionLink(transactionHash: string): string {
  const chainId = Number.parseInt(
    process.env.SUBSCRIPTIONS_CHAIN_ID ?? '1',
    10
  );
  return ethTools.toEtherScanTransactionLink(chainId, transactionHash);
}

async function sendSubscriptionWaveNotifications(
  notifications: SubscriptionWaveNotification[]
): Promise<void> {
  for (const notification of notifications) {
    switch (notification.kind) {
      case 'no-subscription-found':
        await sendNoSubscriptionFoundWaveWarning({
          airdropAddress: notification.airdropAddress,
          transactionLink: notification.transactionLink
        });
        break;
      case 'no-balance-found':
        await sendNoBalanceFoundWaveError({
          consolidationKey: notification.consolidationKey,
          transactionLink: notification.transactionLink
        });
        break;
      case 'insufficient-balance':
        await sendInsufficientBalanceWaveError({
          consolidationKey: notification.consolidationKey,
          transactionLink: notification.transactionLink
        });
        break;
    }
  }
}
