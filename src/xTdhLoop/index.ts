import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';
import { RequestContext } from '../request.context';
import { Timer } from '../time';
import { recalculateXTdhUseCase } from '../xtdh/recalculate-xtdh.use-case';

const logger = Logger.get('XTDH_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const ctx: RequestContext = {
        timer: new Timer('XTDH_LOOP')
      };
      await recalculateXTdhUseCase.handle(ctx);
      logger.info(`Loop finished ${JSON.stringify(ctx?.timer)}`);
    },
    {
      logger
    }
  );
});
