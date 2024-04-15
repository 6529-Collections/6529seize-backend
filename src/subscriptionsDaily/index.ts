import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { updateSubscriptions } from './subscriptions';
import {
  NFTFinalSubscription,
  NFTFinalSubscriptionUpload,
  NFTSubscription,
  RedeemedSubscription,
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionMode
} from '../entities/ISubscription';
import { Profile } from '../entities/IProfile';

const logger = Logger.get('SUBSCRIPTIONS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([
    SubscriptionMode,
    NFTSubscription,
    NFTFinalSubscription,
    NFTFinalSubscriptionUpload,
    SubscriptionLog,
    SubscriptionBalance,
    RedeemedSubscription,
    Profile
  ]);
  await updateSubscriptions(process.env.SUBSCRIPTIONS_RESET == 'true');
  await unload();
  logger.info(`[COMPLETE]`);
});
