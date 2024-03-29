import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { discoverTopUps } from './subscription_topups';
import {
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionTopUp
} from '../entities/ISubscription';
import { loadEnv, unload } from '../secrets';

const logger = Logger.get('SUBSCRIPTIONS_TOP_UP_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([SubscriptionTopUp, SubscriptionBalance, SubscriptionLog]);
  await discoverTopUps(process.env.SUBSCRIPTIONS_RESET == 'true');
  await unload();
  logger.info(`[COMPLETE]`);
});
