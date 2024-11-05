import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';
import { ratingsService } from '../rates/ratings.service';
import { revokeParticipationDropsOverVotes } from '../drops/participation-drops-over-vote-revocation';

const logger = Logger.get('OVER_RATES_REVOCATION_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await ratingsService.reduceOverRates();
      await revokeParticipationDropsOverVotes();
    },
    {
      logger
    }
  );
});
