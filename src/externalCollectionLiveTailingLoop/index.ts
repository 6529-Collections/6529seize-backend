import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';
import { externalCollectionLiveTailService } from '../external-indexing/external-collection-live-tailing.service';

const logger = Logger.get('EXTERNAL_COLLECTION_SNAPSHOTTING_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await externalCollectionLiveTailService.liveTailCycle();
    },
    {
      logger
    }
  );
});
