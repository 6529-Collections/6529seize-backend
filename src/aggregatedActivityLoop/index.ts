import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import {
  AggregatedActivity,
  AggregatedActivityMemes,
  ConsolidatedAggregatedActivity,
  ConsolidatedAggregatedActivityMemes
} from '../entities/IAggregatedActivity';
import { updateAggregatedActivity } from './aggregated_activity';
import { MemesSeason } from '../entities/ISeason';

const logger = Logger.get('AGGREGATED_ACTIVITY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await updateAggregatedActivity(process.env.ACTIVITY_RESET === 'true');
    },
    {
      logger,
      entities: [
        MemesSeason,
        AggregatedActivity,
        ConsolidatedAggregatedActivity,
        AggregatedActivityMemes,
        ConsolidatedAggregatedActivityMemes
      ]
    }
  );
});
