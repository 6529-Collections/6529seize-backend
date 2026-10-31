import * as sentryContext from '@/sentry.context';
import { doInDbContext } from '@/secrets';
import { Logger } from '@/logging';
import { Timer } from '@/time';
import { votingCreditReturnNotificationsService } from '@/notifications/voting-credit-return-notifications.service';

const logger = Logger.get('VOTING_CREDIT_RETURN_NOTIFICATIONS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const timer = new Timer('VOTING_CREDIT_RETURN_NOTIFICATIONS_LOOP');
      try {
        await votingCreditReturnNotificationsService.processPending({ timer });
      } finally {
        logger.info(`Finished executing ${timer.getReport()}`);
      }
    },
    { logger, skipRedis: true }
  );
});
