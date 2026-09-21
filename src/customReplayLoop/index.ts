import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info('[CUSTOM REPLAY NOT IMPLEMENTED]');
});
