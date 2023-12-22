import {
  ConsolidatedOwnerMetric,
  ConsolidatedOwnerTransactions,
  OwnerMetric,
  OwnerTransactions
} from '../entities/IOwner';
import { findOwnerMetrics } from '../owner_metrics';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import { Time } from '../time';

const logger = Logger.get('OWNER_METRICS_LOOP');

export const handler = async (event?: any, context?: any) => {
  const timer = Time.now();
  logger.info('[RUNNING]');
  await loadEnv([
    OwnerMetric,
    ConsolidatedOwnerMetric,
    OwnerTransactions,
    ConsolidatedOwnerTransactions
  ]);
  await findOwnerMetrics(process.env.RESET == 'true');
  // await findOwnerMetrics(true);
  await unload();
  logger.info(`[COMPLETED IN ${timer.printTimeDiff()}]`);
};
