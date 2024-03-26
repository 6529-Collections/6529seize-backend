import { Logger } from '../logging.ts';
import * as sentryContext from '../sentry.context.ts';
import { findTopUps } from './subscription_topups.ts';
import {
  SubscriptionBalance,
  SubscriptionTopUp
} from '../entities/ISubscription.ts.ts';
import { loadEnv, unload } from '../secrets.ts';

const logger = Logger.get('SUBSCRIPTIONS_TOP_UP_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([SubscriptionTopUp, SubscriptionBalance]);
  await findTopUps(process.env.SUBSCRIPTIONS_RESET == 'true');
  await unload();
  logger.info(`[COMPLETE]`);
});
