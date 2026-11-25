import type { Context } from 'aws-lambda';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';
import { repRatingsRemovalJob } from '@/rep-ratings-removal/rep-ratings-removal';
import {
  isRepRatingsRemovalEvent,
  parseRepRatingsRemovalRequest
} from '@/rep-ratings-removal/rep-ratings-removal.request';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

/**
 * Operator-invoked one-off jobs, chosen by the payload's `job`. With no job
 * nothing runs.
 */
export const handler = sentryContext.wrapLambdaHandler(
  async (event: unknown, context?: Context) => {
    if (isRepRatingsRemovalEvent(event)) {
      // Refuses a bad payload before connecting to anything.
      const request = parseRepRatingsRemovalRequest(event);
      return doInDbContext(
        () =>
          repRatingsRemovalJob.run(request, {
            remainingMillis: () =>
              context?.getRemainingTimeInMillis?.() ?? Number.MAX_SAFE_INTEGER
          }),
        { logger }
      );
    }
    if (event && typeof event === 'object' && 'job' in event) {
      throw new Error(`Unknown custom replay job ${JSON.stringify(event.job)}`);
    }
    logger.info('[CUSTOM REPLAY NOT IMPLEMENTED]');
  }
);
