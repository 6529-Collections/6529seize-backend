import {
  discoverEns,
  discoverEnsConsolidations,
  discoverEnsDelegations
} from '../ens';
import { ENS } from '../entities/IENS';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';

const logger = Logger.get('DISCOVER_ENS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await discoverEns();
      await discoverEnsDelegations();
      await discoverEnsConsolidations();
    },
    { logger, entities: [ENS] }
  );
});
