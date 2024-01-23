import { loadEnv, unload } from '../secrets';
import { Transaction, LabTransaction } from '../entities/ITransaction';
// import { fetchAndPersistTransactions } from '../transactionsLoop/index';
import { fetchAndPersistTransactions } from '../meme_lab';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';

const logger = Logger.get('TRANSACTIONS_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(
  async (event?: any, context?: any) => {
    const fromBlock = 0;
    const toBlock = undefined;
    logger.info(`[RUNNING] [FROM BLOCK ${fromBlock}] [TO BLOCK ${toBlock}]`);
    await loadEnv([Transaction, LabTransaction]);
    await fetchAndPersistTransactions(fromBlock, toBlock);
    await unload();
    logger.info('[COMPLETE]');
  }
);
