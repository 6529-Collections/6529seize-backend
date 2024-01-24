import { ConsolidatedOwnerMetric, OwnerMetric } from '../entities/IOwner';
import { findOwnerMetrics } from '../owner_metrics';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';

const logger = Logger.get('OWNER_METRICS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(
  async (event?: any, context?: any) => {
    logger.info('[RUNNING]');
    await loadEnv([OwnerMetric, ConsolidatedOwnerMetric]);
    await findOwnerMetrics(process.env.METRICS_RESET == 'true');
    await unload();
    logger.info('[COMPLETE]');
  }
);
