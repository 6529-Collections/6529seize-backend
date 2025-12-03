import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';
import { Timer } from '../time';
import { RequestContext } from '../request.context';
import { reviewXTdhGrantUseCase } from '../xtdh-grants/review-xtdh-grants-in-queue.use-case';

const logger = Logger.get('TDH_GRANTS_REVIEWER_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const ctx: RequestContext = {
        timer: new Timer('TDH_GRANTS_REVIEWER_LOOP')
      };
      await reviewXTdhGrantUseCase.handle(ctx);
      logger.info(ctx.timer!.getReport());
    },
    {
      logger
    }
  );
});
