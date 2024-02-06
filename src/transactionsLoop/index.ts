import { fetchLatestTransactionsBlockNumber, persistTransactions } from '../db';
import { findTransactions } from '../transactions';
import { debugValues, findTransactionValues } from '../transaction_values';
import { discoverEns } from '../ens';
import { loadEnv, unload } from '../secrets';
import { Transaction } from '../entities/ITransaction';
import { User } from '../entities/IUser';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';

const logger = Logger.get('TRANSACTIONS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(
  async (event?: any, context?: any) => {
    await loadEnv([Transaction, User]);
    logger.info('[RUNNING]');
    await transactionsLoop();
    await unload();
    logger.info('[COMPLETE]');
  }
);

export const handlerValues = async (event?: any, context?: any) => {
  await loadEnv();
  logger.info('[RUNNING TRANSACTIONS VALUES]');
  await debugValues();
  logger.info('[TRANSACTIONS VALUES COMPLETE]');
};

async function transactionsLoop() {
  const now = new Date();
  await fetchAndPersistTransactions();
  await discoverEns(now);
}

async function fetchAndPersistTransactions(
  startingBlock?: number,
  latestBlock?: number,
  pageKey?: string
) {
  try {
    let startingBlockResolved;
    if (startingBlock == undefined) {
      startingBlockResolved = await fetchLatestTransactionsBlockNumber();
    } else {
      startingBlockResolved = startingBlock;
    }

    const response = await findTransactions(
      startingBlockResolved,
      latestBlock,
      pageKey
    );

    const transactionsWithValues = await findTransactionValues(
      response.transactions
    );

    await persistTransactions(transactionsWithValues);

    if (response.pageKey) {
      await fetchAndPersistTransactions(
        startingBlockResolved,
        response.latestBlock,
        response.pageKey
      );
    }
  } catch (e: any) {
    logger.error(`[TRANSACTIONS] [ETIMEDOUT!] [RETRYING PROCESS] [${e}]`);
    await fetchAndPersistTransactions(startingBlock, latestBlock, pageKey);
  }
}
