import { loadEnv, unload } from '../secrets';
import {
  Transaction,
  LabTransaction,
  BaseTransaction
} from '../entities/ITransaction';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { sqlExecutor } from '../sql-executor';
import { NULL_ADDRESS, TRANSACTIONS_TABLE } from '../constants';
import { findTransactionValues } from '../transaction_values';
import { persistTransactions } from '../db';
import { Time } from '../time';

const logger = Logger.get('TRANSACTIONS_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([Transaction, LabTransaction]);
  await replayTransactions();
  await unload();
  logger.info('[COMPLETE]');
});

async function replayTransactions() {
  const nextgenContract = '0x45882f9bc325E14FBb298a1Df930C43a874B83ae';
  const MINT_COUNT = 1000;
  const MINT_VALUE = 0.06529;
  const transactions: BaseTransaction[] = await sqlExecutor.execute(
    `SELECT * FROM ${TRANSACTIONS_TABLE} 
      WHERE 
        contract=:nextgenContract 
        AND from_address=:nullAddress`,
    {
      nextgenContract: nextgenContract,
      nullAddress: NULL_ADDRESS
    }
  );

  logger.info(`[FOUND ${transactions.length} MINT TRANSACTIONS]`);

  if (MINT_COUNT !== transactions.length) {
    throw new Error('[MINT COUNT IS WRONG... EXITING...]');
  }

  const batchSize = 100;
  const transactionsWithValues: BaseTransaction[] = [];
  for (let i = 0; i < transactions.length; i += batchSize) {
    const transactionsBatch = transactions.slice(i, i + batchSize);
    const batchValues = await findTransactionValues(transactionsBatch);

    const wrongTransactionsExist = batchValues.some(
      (t) => t.value !== MINT_VALUE
    );

    if (wrongTransactionsExist) {
      throw new Error('[FOUND WRONG TRANSACTION VALUES... EXITING...]');
    }

    transactionsWithValues.push(...batchValues);
    logger.info(
      `[BATCH PROCESSED ${transactionsWithValues.length} / ${transactions.length}]`
    );
    await Time.seconds(5).sleep();
    logger.info(`[EXECUTING NEXT BATCH]`);
  }

  logger.info(
    `[ALL TRANSACTIONS VALUES PROCESSED ${transactionsWithValues.length}]`
  );

  logger.info('[TRANSACTION VALUES CONFIRMED]');

  await persistTransactions(transactionsWithValues);
}
