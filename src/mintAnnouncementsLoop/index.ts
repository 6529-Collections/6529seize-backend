import * as sentryContext from '@/sentry.context';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import { Timer } from '@/time';
import { announceMintStateChangeUseCase } from './announce-mint-state-change.use-case';

const logger = Logger.get('MINT_ANNOUNCEMENTS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const timer = new Timer('MINT_ANNOUNCEMENTS_LOOP');
      try {
        await announceMintStateChangeUseCase.handle({ timer });
      } finally {
        logger.info(`Finished ${timer.getReport()}`);
      }
    },
    { logger, entities: [] }
  );
});
