import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';
import { externalCollectionSnapshottingService } from '../external-indexing/external-collection-snapshotting.service';

const logger = Logger.get('EXTERNAL_COLLECTION_SNAPSHOTTING_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await externalCollectionSnapshottingService.attemptSnapshot();
    },
    {
      logger
    }
  );
});
