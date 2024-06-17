import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { tdhHistoryLoop } from '../tdhHistoryLoop';
import { GlobalTDHHistory, TDHHistory } from '../entities/ITDH';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([TDHHistory, GlobalTDHHistory]);
  await replay();
  await unload();
  logger.info('[COMPLETE]');
});

async function replay() {
  // logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);

  await tdhHistoryLoop(10);
}
