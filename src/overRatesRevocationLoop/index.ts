import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';
import { ratingsService } from '../rates/ratings.service';
import { dropOverRaterRevocationService } from '../drops/drop-over-rater-revocation.service';

const logger = Logger.get('OVER_RATES_REVOCATION_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await ratingsService.reduceOverRates();
      await dropOverRaterRevocationService.revokeOverRates();
    },
    {
      logger
    }
  );
});
