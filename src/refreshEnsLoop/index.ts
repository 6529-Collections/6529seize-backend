import { refreshEns } from '../ens';
import { ENS } from '../entities/IENS';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';

const logger = Logger.get('REFRESH_ENS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await refreshEns();
    },
    {
      logger,
      entities: [ENS]
    }
  );
  await refreshEns();
});
