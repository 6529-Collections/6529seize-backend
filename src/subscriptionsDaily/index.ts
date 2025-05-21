import { doInDbContext } from '../secrets';
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

const logger = Logger.get('SUBSCRIPTIONS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await updateSubscriptions();
    },
    {
      logger,
      entities: [
        SubscriptionMode,
        NFTSubscription,
        NFTFinalSubscription,
        NFTFinalSubscriptionUpload,
        SubscriptionLog,
        SubscriptionBalance,
        RedeemedSubscription
      ]
    }
  );
});
