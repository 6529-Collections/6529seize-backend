import { EntityManager } from 'typeorm';
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
  RedeemedSubscription,
  SubscriptionBalance
} from '../entities/ISubscription';
import { Transaction } from '../entities/ITransaction';
import { TransactionsProcessedSubscriptionsBlock } from '../entities/ITransactionsProcessing';
import { ethTools } from '../eth-tools';
import { Logger } from '../logging';
import { sendDiscordUpdate } from '../notifier-discord';
import { sqlExecutor } from '../sql-executor';
import { equalIgnoreCase } from '../strings';
import { fetchSubscriptionBalanceForConsolidationKey } from '../subscriptionsDaily/db.subscriptions';
import {
  getLastProcessingBlock,
  persistBlock
} from './db.transactions_processing';

const logger = Logger.get('TRANSACTIONS_PROCESSING_SUBSCRIPTIONS');

export const redeemSubscriptions = async (reset?: boolean) => {
  const blockRepo = getDataSource().getRepository(
    TransactionsProcessedSubscriptionsBlock
  );
  const lastProcessingBlock = await getLastProcessingBlock(blockRepo, reset);
  const maxBlockTransaction = await fetchMaxTransactionByBlockNumber();

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
  const airdrops: Transaction[] = await sqlExecutor.execute(
    `SELECT * FROM ${TRANSACTIONS_TABLE}
    WHERE block > :lastProcessingBlock
    AND from_address = :nullAddress
    AND value = 0
    AND token_count > 0
    ORDER BY block asc;`,
    {
      lastProcessingBlock,
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

  await getDataSource().transaction(async (entityManager) => {
    for (const drop of airdrops) {
      await processAirdrop(drop, entityManager);
    }
    const transactionBlockRepo = entityManager.getRepository(
      TransactionsProcessedSubscriptionsBlock
    );
    await persistBlock(transactionBlockRepo, maxBlockTransaction);
    logger.info(`[BLOCK ${maxBlockTransaction.block} PERSISTED]`);
  });
};

export async function processAirdrop(
  transaction: Transaction,
  entityManager: EntityManager
) {
  const validation = await validateNonSubscriptionAirdrop(
    transaction,
    entityManager
  );

  if (validation.valid) {
    return;
  }

  for (let i = 0; i < transaction.token_count; i++) {
    await processSubscription(transaction, entityManager);
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
      `SELECT * FROM ${DISTRIBUTION_TABLE} 
        WHERE LOWER(wallet) = ?
        AND LOWER(phase) = ?
        AND LOWER(contract) = ?
        AND card_id = ?;`,
      [
        transaction.to_address.toLowerCase(),
        'airdrop',
        transaction.contract.toLowerCase(),
        transaction.token_id
      ]
    )
  )[0];

  if (distributionAirdrop) {
    const previousAirdrops = (
      await entityManager.query(
        `SELECT SUM(token_count) as previous_airdrops FROM ${TRANSACTIONS_TABLE}
        WHERE contract = ?
        AND token_id = ?
        AND from_address = ?
        AND block < ?
        AND value = 0;`,
        [
          transaction.contract,
          transaction.token_id,
          NULL_ADDRESS,
          transaction.block
        ]
      )
    )[0].previous_airdrops;
    if (
      distributionAirdrop.count >=
      previousAirdrops + transaction.token_count
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

async function processSubscription(
  transaction: Transaction,
  entityManager: EntityManager
) {
  const finalSubscription: NFTFinalSubscription | undefined = (
    await entityManager.query(
      `SELECT * FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
      WHERE ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.contract = ?
      AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.token_id = ?
      AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.airdrop_address = ?
      AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.redeemed_count < ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.subscribed_count
      ORDER BY phase ASC, phase_position ASC;`,
      [transaction.contract, transaction.token_id, transaction.to_address]
    )
  )[0];

  if (!finalSubscription) {
    const message = `No subscription found for airdrop address: ${
      transaction.to_address
    } \nTransaction: ${ethTools.toEtherScanTransactionLink(
      1,
      transaction.transaction
    )}`;
    logger.warn(message);
    await sendDiscordUpdate(
      process.env.SUBSCRIPTIONS_DISCORD_WEBHOOK as string,
      message,
      'Subscriptions',
      'warn'
    );
    return;
  }

  let balance = await fetchSubscriptionBalanceForConsolidationKey(
    finalSubscription.consolidation_key,
    entityManager
  );
  if (!balance) {
    const message = `No balance found for consolidation key: ${
      finalSubscription.consolidation_key
    } \nTransaction: ${ethTools.toEtherScanTransactionLink(
      1,
      transaction.transaction
    )}`;
    logger.error(message);
    await sendDiscordUpdate(
      process.env.SUBSCRIPTIONS_DISCORD_WEBHOOK as string,
      message,
      'Subscriptions',
      'error'
    );
    balance = {
      consolidation_key: finalSubscription.consolidation_key,
      balance: 0
    };
  } else if (MEMES_MINT_PRICE > balance.balance) {
    const message = `Insufficient balance for consolidation key: ${
      finalSubscription.consolidation_key
    } \nTransaction: ${ethTools.toEtherScanTransactionLink(
      1,
      transaction.transaction
    )}`;
    logger.error(message);
    await sendDiscordUpdate(
      process.env.SUBSCRIPTIONS_DISCORD_WEBHOOK as string,
      message,
      'Subscriptions',
      'error'
    );
  }

  let balanceAfter = balance.balance - MEMES_MINT_PRICE;
  balanceAfter = Math.round(balanceAfter * 100000) / 100000;
  balance.balance = balanceAfter;

  await entityManager.getRepository(SubscriptionBalance).save(balance);

  const existingRedeemed = await entityManager
    .getRepository(RedeemedSubscription)
    .findOne({
      where: {
        contract: transaction.contract,
        token_id: transaction.token_id,
        address: transaction.to_address,
        transaction: transaction.transaction,
        consolidation_key: finalSubscription.consolidation_key
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
      consolidation_key: finalSubscription.consolidation_key,
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
}
