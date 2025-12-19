import {
  NFTFinalSubscription,
  NFTFinalSubscriptionUpload,
  NFTSubscription,
  RedeemedSubscription,
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionMode
} from '../entities/ISubscription';
import { Logger } from '../logging';
import * as priorityAlertsContext from '../priority-alerts.context';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { updateSubscriptions } from './subscriptions';

const logger = Logger.get('SUBSCRIPTIONS_LOOP');
const ALERT_TITLE = 'Subscriptions Daily Loop';

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    priorityAlertsContext.wrapAsyncFunction(ALERT_TITLE, async () => {
      await updateSubscriptions();
    }),
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
