import {
  ConsolidatedOwnerMetric,
  ConsolidatedOwnerTransactions,
  OwnerBalances,
  OwnerMemesBalances,
  OwnerMetric,
  OwnerTransactions
} from '../entities/IOwner';
import { findOwnerMetrics } from '../owner_metrics';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';

const logger = Logger.get('OWNER_METRICS_LOOP');

export const handler = async (event?: any, context?: any) => {
  logger.info('[RUNNING]');
  await loadEnv([
    OwnerMetric,
    ConsolidatedOwnerMetric,
    OwnerBalances,
    OwnerMemesBalances,
    OwnerTransactions,
    ConsolidatedOwnerTransactions
  ]);
  // await findOwnerMetrics(process.env.RESET == 'true');
  await findOwnerMetrics(true);
  await unload();
  logger.info('[COMPLETE]');
};
