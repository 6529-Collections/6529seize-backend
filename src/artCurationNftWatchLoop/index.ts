import { artCurationTokenWatchService } from '@/art-curation/art-curation-token-watch.service';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import { Timer } from '@/time';

const logger = Logger.get('ART_CURATION_NFT_WATCH_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const timer = new Timer('ART_CURATION_NFT_WATCH_LOOP');
      const processed = await artCurationTokenWatchService.processCycle(timer);
      logger.info(
        `Processed ${processed} Art Curation NFT watches in ${timer.getReport()}`
      );
    },
    {
      logger
    }
  );
});
