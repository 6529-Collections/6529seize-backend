import * as sentryContext from '../sentry.context';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import { Timer } from '../time';
import { waveLeaderboardCalculationService } from '../api-serverless/src/waves/wave-leaderboard-calculation.service';

const logger = Logger.get('WAVE_LEADERBOARD_SNAPSHOTTER_KOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const timer = new Timer('WAVE_LEADERBOARD_SNAPSHOTTER_KOOP');
      try {
        await waveLeaderboardCalculationService.refreshLeaderboardEntriesForDropsInNeed(
          timer
        );
      } finally {
        logger.info(`Finished executing ${timer.getReport()}`);
      }
    },
    { logger, entities: [Transaction] }
  );
});
