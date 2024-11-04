import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { tdhHistoryLoop } from '../tdhHistoryLoop';
import { GlobalTDHHistory } from '../entities/ITDH';
import { TDHHistory } from '../entities/ITDH';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await replay();
    },
    {
      logger,
      entities: [TDHHistory, GlobalTDHHistory]
    }
  );
});

async function replay() {
  // logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);

  await tdhHistoryLoop(5);
}
