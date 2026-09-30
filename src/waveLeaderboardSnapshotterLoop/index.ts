import * as sentryContext from '../sentry.context';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import { Timer } from '../time';
import { waveLeaderboardCalculationService } from '../waves/wave-leaderboard-calculation.service';
import { nativeCompetitionRuntimeService } from '@/competitions/native-competition-runtime.service';
import { runCompetitionWorkerTasks } from '@/competitions/competition-worker-tasks';

const logger = Logger.get('WAVE_LEADERBOARD_SNAPSHOTTER_KOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const timer = new Timer('WAVE_LEADERBOARD_SNAPSHOTTER_KOOP');
      try {
        await runCompetitionWorkerTasks([
          // Preserve timely legacy leaderboard updates even when the native
          // competition scan consumes the rest of the invocation.
          () =>
            waveLeaderboardCalculationService.refreshLeaderboardEntriesForDropsInNeed(
              timer
            ),
          () => nativeCompetitionRuntimeService.refreshNativeLeaderboards(timer)
        ]);
      } finally {
        logger.info(`Finished executing ${timer.getReport()}`);
      }
    },
    { logger, entities: [Transaction] }
  );
});
