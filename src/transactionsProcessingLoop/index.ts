import { updateDistributionMints } from './distribution';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { Time } from '../time';
import {
  TransactionsProcessedDistributionBlock,
  TransactionsProcessedDistributionTransaction
} from '../entities/ITransactionsProcessing';

const logger = Logger.get('TRANSACTIONS_PROCESSING_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  const start = Time.now();
  logger.info('[RUNNING]');
  await loadEnv([
    TransactionsProcessedDistributionBlock,
    TransactionsProcessedDistributionTransaction
  ]);
  await updateDistributionMints(
    process.env.TRANSACTIONS_PROCESSING_RESET == 'true'
  );
  await unload();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
});
