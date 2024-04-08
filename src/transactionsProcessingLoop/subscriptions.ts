import {
  MEMES_MINT_PRICE,
  NULL_ADDRESS,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  TEAM_TABLE,
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

const logger = Logger.get('TRANSACTIONS_PROCESSING_SUBSCRIPTIONS');

export const redeemSubscriptions = async (reset?: boolean) => {
  let blockRepo = getDataSource().getRepository(
    TransactionsProcessedSubscriptionsBlock
  );
  const lastProcessingBlock = await getLastProcessingBlock(blockRepo, reset);
  const maxBlockTransaction = await fetchMaxTransactionByBlockNumber();

  const transactions: Transaction[] = await sqlExecutor.execute(
    `SELECT * FROM ${TRANSACTIONS_TABLE} 
    WHERE block > :lastProcessingBlock 
    AND from_address = :nullAddress
    AND value = 0
    ORDER BY block asc;`,
    {
      lastProcessingBlock,
      nullAddress: NULL_ADDRESS
    }
  );

  if (transactions.length === 0) {
    logger.info(`[NO TRANSACTIONS TO PROCESS]`);
    await persistBlock(blockRepo, maxBlockTransaction);
    logger.info(`[BLOCK ${maxBlockTransaction.block} PERSISTED]`);
    return;
  }

  logger.info(`[${transactions.length} TRANSACTIONS TO PROCESS]`);

  await getDataSource().transaction(async (entityManager) => {
    for (const tr of transactions) {
      await redeemSubscriptionAirdrop(tr, entityManager);
    }
    blockRepo = entityManager.getRepository(
      TransactionsProcessedSubscriptionsBlock
    );
    await persistBlock(blockRepo, maxBlockTransaction);
    logger.info(`[BLOCK ${maxBlockTransaction.block} PERSISTED]`);
  });
};

async function redeemSubscriptionAirdrop(
  transaction: Transaction,
  entityManager: EntityManager
) {
  // TODO: REMOVE THIS
  transaction.to_address = '0xfe49a85e98941f1a115acd4beb98521023a25802';

  logger.info(
    `[REDEEMING SUBSCRIPTION AIRDROP] : [Transaction ${transaction.transaction}]`
  );

  const finalSubscription: NFTFinalSubscription | undefined = (
    await entityManager.query(
      `SELECT * FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
    WHERE ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.contract = "${transaction.contract}"
    AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.token_id = ${transaction.token_id}
    AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.airdrop_address = "${transaction.to_address}"
    AND ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}.redeemed = false;`
    )
  )[0];

  const team = (
    await sqlExecutor.execute(
      `SELECT * FROM ${TEAM_TABLE} WHERE LOWER(wallet) = '${transaction.to_address}'`
    )
  )[0];
  const isTeamMemeber = !!team;

  if (!finalSubscription) {
    const message = `No subscription found for airdrop address: ${transaction.to_address} \nTransaction: ${transaction.transaction} \nAddress ${transaction.to_address}`;
    logger.warn(message);
    if (!isTeamMemeber) {
      await sendDiscordUpdate(
        process.env.SUBSCRIPTIONS_DISCORD_WEBHOOK as string,
        message,
        'Subscriptions',
        'warn'
      );
    }
    return;
  }

  let balance = await fetchSubscriptionBalanceForConsolidationKey(
    finalSubscription.consolidation_key,
    entityManager
  );
  if (!balance) {
    const message = `No balance found for consolidation key: ${finalSubscription.consolidation_key} \nTransaction: ${transaction.transaction}`;
    logger.error(message);
    balance = {
      consolidation_key: finalSubscription.consolidation_key,
      balance: 0
    };
    await sendDiscordUpdate(
      process.env.SUBSCRIPTIONS_DISCORD_WEBHOOK as string,
      message,
      'Subscriptions',
      'error'
    );
  } else if (MEMES_MINT_PRICE > balance.balance) {
    const message = `Insufficient balance for consolidation key: ${finalSubscription.consolidation_key} \nTransaction: ${transaction.transaction}`;
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
