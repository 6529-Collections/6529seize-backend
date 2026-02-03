import { EntityManager } from 'typeorm';
import {
  DISTRIBUTION_NORMALIZED_TABLE,
  MANIFOLD,
  NULL_ADDRESS,
  TRANSACTIONS_TABLE
} from '@/constants';
import { fetchMaxTransactionByBlockNumber, getDataSource } from '../db';
import { DistributionNormalized } from '../entities/IDistribution';
import { Transaction } from '../entities/ITransaction';
import { TransactionsProcessedDistributionBlock } from '../entities/ITransactionsProcessing';
import { Logger } from '../logging';
import { sqlExecutor } from '../sql-executor';
import {
  getLastProcessingBlock,
  persistBlock
} from './db.transactions_processing';

const logger = Logger.get('TRANSACTIONS_PROCESSING_DISTRIBUTIONS');

export const updateDistributionMints = async (reset?: boolean) => {
  let blockRepo = getDataSource().getRepository(
    TransactionsProcessedDistributionBlock
  );
  const lastProcessingBlock = await getLastProcessingBlock(blockRepo, reset);
  const maxBlockTransaction = await fetchMaxTransactionByBlockNumber();

  if (!maxBlockTransaction) {
    throw new Error('No max transaction block');
  }

  const transactions: Transaction[] = await sqlExecutor.execute(
    `SELECT * FROM ${TRANSACTIONS_TABLE} 
    WHERE block > :lastProcessingBlock 
    AND from_address IN (:manifold, :nullAddress)
    AND value > 0
    ORDER BY block asc;`,
    {
      lastProcessingBlock,
      manifold: MANIFOLD,
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
      await processTransaction(tr, entityManager);
    }
    blockRepo = entityManager.getRepository(
      TransactionsProcessedDistributionBlock
    );
    await persistBlock(blockRepo, maxBlockTransaction);
    logger.info(`[BLOCK ${maxBlockTransaction.block} PERSISTED]`);
  });
};

async function processTransaction(
  transaction: Transaction,
  entityManager: EntityManager
) {
  const filters = `
    WHERE LOWER(${DISTRIBUTION_NORMALIZED_TABLE}.wallet) = LOWER("${transaction.to_address}")
    AND LOWER(${DISTRIBUTION_NORMALIZED_TABLE}.contract) = LOWER("${transaction.contract}")
    AND ${DISTRIBUTION_NORMALIZED_TABLE}.card_id = ${transaction.token_id}`;

  const distribution: DistributionNormalized[] = await entityManager.query(
    `SELECT * FROM ${DISTRIBUTION_NORMALIZED_TABLE} ${filters}`
  );

  if (distribution.length === 0) {
    logger.info(
      `[MINT WITH NO DISTRIBUTION FOUND FOR HASH ${transaction.transaction}] : [CONTRACT ${transaction.contract}] :[TOKEN ID ${transaction.token_id}]`
    );
  }

  if (distribution.length === 1) {
    const newMinted = distribution[0].minted + transaction.token_count;
    const newTotal = newMinted + distribution[0].airdrops;
    await entityManager.query(
      `UPDATE ${DISTRIBUTION_NORMALIZED_TABLE} 
      SET minted = ${newMinted} , total_count = ${newTotal}
      ${filters}`
    );
  }

  if (distribution.length > 1) {
    logger.error(
      `[DUPLICATE DISTRIBUTIONS FOUND FOR ${transaction.to_address} ${transaction.contract} ${transaction.token_id}]`
    );
  }
}
