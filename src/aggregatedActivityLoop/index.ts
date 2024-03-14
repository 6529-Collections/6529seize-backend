import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import {
  AggregatedActivity,
  ConsolidatedAggregatedActivity,
  AggregatedActivityMemes,
  ConsolidatedAggregatedActivityMemes
} from '../entities/IAggregatedActivity';
import { findAggregatedActivity } from './aggregated_activity';
import { MemesSeason } from '../entities/ISeason';
import { Time } from '../time';

const logger = Logger.get('AGGREGATED_ACTIVITY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(
  async (event?: any, context?: any) => {
    const start = Time.now();
    logger.info('[RUNNING]');
    await loadEnv([
      MemesSeason,
      AggregatedActivity,
      ConsolidatedAggregatedActivity,
      AggregatedActivityMemes,
      ConsolidatedAggregatedActivityMemes
    ]);
    await findAggregatedActivity(process.env.ACTIVITY_RESET === 'true');
    await unload();
    const diff = start.diffFromNow().formatAsDuration();
    logger.info(`[COMPLETE IN ${diff}]`);
  }
);
