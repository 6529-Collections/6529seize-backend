import * as sentryContext from '../sentry.context';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import { Timer } from '../time';
import { nativeCompetitionRuntimeService } from '@/competitions/native-competition-runtime.service';
import { competitionEventDispatcher } from '@/competitions/competition-event-dispatcher';
import { runCompetitionWorkerTasks } from '@/competitions/competition-worker-tasks';
import { observeDecisionBacklogs } from './loop-health';
import {
  decisionLoopBudget,
  finalDispatchBudgetMs
} from './decision-loop-budget';

const logger = Logger.get('WAVE_DECISION_EXECUTION_LOOP');

export const handler = sentryContext.wrapLambdaHandler(
  async (_event, context) => {
    await doInDbContext(
      async () => {
        const timer = new Timer('WAVE_DECISION_EXECUTION_LOOP');
        const remainingMillis = context?.getRemainingTimeInMillis
          ? () => context.getRemainingTimeInMillis()
          : undefined;
        const budget = decisionLoopBudget();
        try {
          await runCompetitionWorkerTasks([
            // Outbox delivery gets its share before any decision work.
            () =>
              competitionEventDispatcher.dispatchPending(
                { timer },
                Date.now(),
                { budgetMs: budget.dispatchFirstMs }
              ),
            () =>
              nativeCompetitionRuntimeService.processDueCompetitions({
                timer,
                remainingMillis,
                budgetMs: budget.decisionsBudgetMs,
                competitionDeadlineMs: budget.competitionDeadlineMs,
                reserveMillis: budget.reserveMillis
              }),
            // Then the results of this pass's decisions, and the rest.
            () => {
              const budgetMs = finalDispatchBudgetMs(remainingMillis?.());
              return competitionEventDispatcher.dispatchPending(
                { timer },
                Date.now(),
                budgetMs === undefined ? {} : { budgetMs }
              );
            }
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
