import { EntityManager } from 'typeorm';
import {
  DISTRIBUTION_NORMALIZED_TABLE,
  MANIFOLD,
  NULL_ADDRESS,
  TRANSACTIONS_TABLE
} from '../constants';
import { fetchMaxTransactionByBlockNumber, getDataSource } from '../db';
import { DistributionNormalized } from '../entities/IDistribution';
import { Transaction } from '../entities/ITransaction';
import { TransactionsProcessedDistributionBlock } from '../entities/ITransactionsProcessing';
import { areEqualAddresses } from '../helpers';
import { Logger } from '../logging';

const logger = Logger.get('TRANSACTIONS_PROCESSING_LOOP');

export const updateDistributionMints = async (reset?: boolean) => {
  const lastProcessingBlock: number =
    (
      await getDataSource()
        .getRepository(TransactionsProcessedDistributionBlock)
        .createQueryBuilder('trxDistributionBlock')
        .select('MAX(trxDistributionBlock.block)', 'max_block')
        .getRawOne()
    )?.max_block ?? 0;

  const maxTransactionsBlock = await fetchMaxTransactionByBlockNumber();

  logger.info(
    `[LAST DISTRIBUTION BLOCK: ${lastProcessingBlock}] : [LAST BLOCK: ${maxTransactionsBlock.block}]`
  );

  const transactions: Transaction[] = await getDataSource().manager.query(
    `SELECT * FROM ${TRANSACTIONS_TABLE} 
    WHERE block > ${lastProcessingBlock} 
    AND from_address IN ("${NULL_ADDRESS}","${MANIFOLD}")
    AND value > 0
    ORDER BY block asc;`
  );

  if (transactions.length === 0) {
    logger.info(`[NO TRANSACTIONS TO PROCESS]`);
    await persistBlock(maxTransactionsBlock);
    return;
  }

  const distinctDistributions: { contract: string; card_id: number }[] =
    await getDataSource().manager.query(
      `SELECT DISTINCT contract, card_id FROM ${DISTRIBUTION_NORMALIZED_TABLE};`
    );

  const filteredTransactions: Transaction[] = transactions.filter(
    (transaction) =>
      distinctDistributions.some(
        (distribution) =>
          areEqualAddresses(transaction.contract, distribution.contract) &&
          Number(transaction.token_id) === Number(distribution.card_id)
      )
  );

  logger.info(
    `[${transactions.length} TRANSACTIONS TO PROCESS] : [${distinctDistributions.length} DISTINCT DISTRIBUTIONS] : [${filteredTransactions.length} FILTERED TRANSACTIONS]`
  );

  await getDataSource().transaction(async (entityManager) => {
    for (const tr of transactions) {
      await processTransaction(entityManager, tr);
    }
    await persistBlock(maxTransactionsBlock, entityManager);
  });

  logger.info(`[ALL TRANSACTIONS PROCESSED]`);
};

async function processTransaction(
  entityManager: EntityManager,
  transaction: Transaction
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

async function persistBlock(tx: Transaction, manager?: EntityManager) {
  let dataSource = manager ?? getDataSource();
  await dataSource.getRepository(TransactionsProcessedDistributionBlock).save({
    block: tx.block,
    timestamp: new Date(tx.transaction_date).getTime()
  });
}
