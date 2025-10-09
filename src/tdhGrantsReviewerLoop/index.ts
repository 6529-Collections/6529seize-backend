import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { doInDbContext } from '../secrets';
import { reviewTdhGrantUseCase } from '../tdh-grants/review-tdh-grants-in-queue.use-case';
import { Timer } from '../time';
import { RequestContext } from '../request.context';

const logger = Logger.get('TDH_GRANTS_REVIEWER_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const ctx: RequestContext = {
        timer: new Timer('TDH_GRANTS_REVIEWER_LOOP')
      };
      await reviewTdhGrantUseCase.handle(ctx);
      logger.info(ctx.timer!.getReport());
    },
    {
      logger
    }
  );
});
