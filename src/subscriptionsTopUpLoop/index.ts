import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { discoverTopUps } from './subscription_topups';
import {
  NFTFinalSubscription,
  NFTFinalSubscriptionUpload,
  NFTSubscription,
  RedeemedSubscription,
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionMode,
  SubscriptionTopUp,
  SubscriptionTopUpLatestBlock
} from '../entities/ISubscription';
import { doInDbContext } from '../secrets';

const logger = Logger.get('SUBSCRIPTIONS_TOP_UP_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await discoverTopUps(process.env.SUBSCRIPTIONS_RESET == 'true');
    },
    {
      logger,
      entities: [
        SubscriptionTopUp,
        SubscriptionBalance,
        SubscriptionLog,
        SubscriptionMode,
        RedeemedSubscription,
        NFTSubscription,
        NFTFinalSubscription,
        NFTFinalSubscriptionUpload,
        SubscriptionTopUpLatestBlock
      ]
    }
  );
});
