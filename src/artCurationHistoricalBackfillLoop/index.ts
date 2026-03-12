import { artCurationTokenWatchService } from '@/art-curation/art-curation-token-watch.service';
import { env } from '@/env';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import { Timer } from '@/time';

const logger = Logger.get('ART_CURATION_HISTORICAL_BACKFILL_LOOP');

function isDryRunEnabled(): boolean {
  const value =
    env.getStringOrNull('ART_CURATIONS_BACKFILL_DRY_RUN')?.toLowerCase() ?? '';
  return value === '1' || value === 'true' || value === 'yes';
}

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const timer = new Timer('ART_CURATION_HISTORICAL_BACKFILL_LOOP');
      const dryRun = isDryRunEnabled();
      const processed =
        await artCurationTokenWatchService.processHistoricalBackfillCycle(
          timer,
          { dryRun }
        );
      logger.info(
        `Processed ${processed} Art Curation historical backfill token groups in ${timer.getReport()} [MODE ${dryRun ? 'DRY_RUN' : 'LIVE'}]`
      );
    },
    {
      logger
    }
  );
});
