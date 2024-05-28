import {
  DISTRIBUTION_TABLE,
  MEMES_CONTRACT,
  MEMES_MINT_PRICE,
  NULL_ADDRESS,
  RESEARCH_6529_ADDRESS,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  TRANSACTIONS_TABLE
} from '../constants';
import { fetchMaxTransactionByBlockNumber, getDataSource } from '../db';
import { TransactionsProcessedSubscriptionsBlock } from '../entities/ITransactionsProcessing';
import {
  getLastProcessingBlock,
  persistBlock
} from './db.transactions_processing';
import { Logger } from '../logging';
import { Transaction } from '../entities/ITransaction';
import { EntityManager } from 'typeorm';
import {
  SubscriptionBalance,
  RedeemedSubscription,
  NFTFinalSubscription
} from '../entities/ISubscription';
import { sqlExecutor } from '../sql-executor';
import { fetchSubscriptionBalanceForConsolidationKey } from '../subscriptionsDaily/db.subscriptions';
import { sendDiscordUpdate } from '../notifier-discord';
import { areEqualAddresses, getTransactionLink } from '../helpers';

const logger = Logger.get('TRANSACTIONS_PROCESSING_SUBSCRIPTIONS');

export const redeemSubscriptions = async (reset?: boolean) => {
  let blockRepo = getDataSource().getRepository(
    TransactionsProcessedSubscriptionsBlock
  );
  const lastProcessingBlock = await getLastProcessingBlock(blockRepo, reset);
  const maxBlockTransaction = await fetchMaxTransactionByBlockNumber();

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
    blockRepo = entityManager.getRepository(
      TransactionsProcessedSubscriptionsBlock
    );
    await persistBlock(blockRepo, maxBlockTransaction);
    logger.info(`[BLOCK ${maxBlockTransaction.block} PERSISTED]`);
  });
};

async function processAirdrop(
  transaction: Transaction,
  entityManager: EntityManager
) {
  if (!areEqualAddresses(MEMES_CONTRACT, transaction.contract)) {
    logger.info(
      `[SKIPPING TRANSACTION] : [CONTRACT ${transaction.contract}] : [Transaction ${transaction.transaction}]`
    );
    return;
  } else {
    logger.info(
      `[PROCESSING AIRDROP] : [Transaction ${transaction.transaction}]`
    );
  }

  if (areEqualAddresses(RESEARCH_6529_ADDRESS, transaction.to_address)) {
    logger.info(
      `[SKIPPING TRANSACTION] : [AIRDROP TO RESEARCH] : [Transaction ${transaction.transaction}]`
    );
    return;
  }

  const distributionAirdrop = (
    await sqlExecutor.execute(
      `SELECT * FROM ${DISTRIBUTION_TABLE} 
        WHERE LOWER(wallet) = :toAddress 
        AND LOWER(phase) = :phase 
        AND LOWER(contract) = :contract 
        AND card_id = :tokenId;`,
      {
        toAddress: transaction.to_address.toLowerCase(),
        phase: 'airdrop',
        contract: transaction.contract.toLowerCase(),
        tokenId: transaction.token_id
      }
    )
  )[0];

  if (distributionAirdrop) {
    const previousAirdrops = (
      await entityManager.query(
        `SELECT SUM(token_count) as previous_airdrops FROM ${TRANSACTIONS_TABLE}
        WHERE contract = "${transaction.contract}"
        AND token_id = ${transaction.token_id}
        AND from_address = "${NULL_ADDRESS}"
        AND block < ${transaction.block}
        AND value = 0;`
      )
    )[0].previous_airdrops;
    if (
      distributionAirdrop.count >=
      previousAirdrops + transaction.token_count
    ) {
      return;
    }
  }

  for (let i = 0; i < transaction.token_count; i++) {
    await processSubscription(transaction, entityManager);
  }
}

async function processSubscription(
  transaction: Transaction,
  entityManager: EntityManager
) {
  const finalSubscription: NFTFinalSubscription | undefined = (
    await entityManager.query(
      `SELECT * FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
      WHERE ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.contract = "${transaction.contract}"
      AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.token_id = ${transaction.token_id}
      AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.airdrop_address = "${transaction.to_address}"
      AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.redeemed = false
      ORDER BY phase ASC, phase_position ASC;`
    )
  )[0];

  if (!finalSubscription) {
    const message = `No subscription found for airdrop address: ${
      transaction.to_address
    } \nTransaction: ${getTransactionLink(1, transaction.transaction)}`;
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
    } \nTransaction: ${getTransactionLink(1, transaction.transaction)}`;
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
    } \nTransaction: ${getTransactionLink(1, transaction.transaction)}`;
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

  const redeemedSubscription: RedeemedSubscription = {
    contract: transaction.contract,
    token_id: transaction.token_id,
    address: transaction.to_address,
    transaction: transaction.transaction,
    transaction_date: transaction.transaction_date,
    consolidation_key: finalSubscription.consolidation_key,
    value: MEMES_MINT_PRICE,
    balance_after: balanceAfter
  };

  await entityManager
    .getRepository(RedeemedSubscription)
    .save(redeemedSubscription);

  finalSubscription.redeemed = true;
  await entityManager
    .getRepository(NFTFinalSubscription)
    .save(finalSubscription);
}
