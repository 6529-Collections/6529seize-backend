import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';
import { RequestContext } from '../request.context';
import { Timer } from '../time';
import { recalculateXTdhStatsUseCase } from '../tdh-grants/recalculate-xtdh-stats.use-case';

const logger = Logger.get('XTDH_STATS_NORMALISATION_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const ctx: RequestContext = {
        timer: new Timer('XTDH_STATS_NORMALISATION_LOOP')
      };
      await recalculateXTdhStatsUseCase.handle(ctx);
      logger.info(`Loop finished ${JSON.stringify(ctx?.timer)}`);
    },
    {
      logger
    }
  );
});
