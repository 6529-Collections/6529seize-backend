import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { updateSubscriptions } from './subscriptions';
import {
  NFTSubscription,
  SubscriptionLog,
  SubscriptionMode
} from '../entities/ISubscription';

const logger = Logger.get('SUBSCRIPTIONS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([SubscriptionMode, NFTSubscription, SubscriptionLog]);
  await updateSubscriptions(process.env.SUBSCRIPTIONS_RESET == 'true');
  await unload();
  logger.info(`[COMPLETE]`);
});
