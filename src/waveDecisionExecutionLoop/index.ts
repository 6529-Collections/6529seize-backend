import * as sentryContext from '../sentry.context';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import { Timer } from '../time';
import { nativeCompetitionRuntimeService } from '@/competitions/native-competition-runtime.service';
import { competitionEventDispatcher } from '@/competitions/competition-event-dispatcher';
import { runCompetitionWorkerTasks } from '@/competitions/competition-worker-tasks';
import { observeDecisionBacklogs } from './loop-health';

const logger = Logger.get('WAVE_DECISION_EXECUTION_LOOP');

export const handler = sentryContext.wrapLambdaHandler(
  async (_event, context) => {
    await doInDbContext(
      async () => {
        const timer = new Timer('WAVE_DECISION_EXECUTION_LOOP');
        try {
          await runCompetitionWorkerTasks([
            () =>
              nativeCompetitionRuntimeService.processDueCompetitions({ timer }),
            () => competitionEventDispatcher.dispatchPending({ timer })
          ]);
        } finally {
          if (
            !context?.getRemainingTimeInMillis ||
            context.getRemainingTimeInMillis() > 5000
          )
            await observeDecisionBacklogs();
          logger.info(`Finished executing ${timer.getReport()}`);
        }
      },
      { logger, entities: [Transaction] }
    );
  }
);
