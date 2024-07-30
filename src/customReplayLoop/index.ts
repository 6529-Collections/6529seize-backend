import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { consolidateActivity } from '../aggregatedActivityLoop/aggregated_activity';
import {
  AggregatedActivity,
  ConsolidatedAggregatedActivity,
  AggregatedActivityMemes,
  ConsolidatedAggregatedActivityMemes
} from '../entities/IAggregatedActivity';
import { MemesSeason } from '../entities/ISeason';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([
    MemesSeason,
    AggregatedActivity,
    ConsolidatedAggregatedActivity,
    AggregatedActivityMemes,
    ConsolidatedAggregatedActivityMemes
  ]);
  await replay();
  await unload();
  logger.info('[COMPLETE]');
});

async function replay() {
  // logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);
  const wallets = new Set<string>();
  wallets.add('0xf1f476f144df01480297dca47efca565e8b0c9f1');

  await consolidateActivity(wallets);
}
