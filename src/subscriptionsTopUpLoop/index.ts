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
import { Logger } from '../logging';
import * as priorityAlertsContext from '../priority-alerts.context';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { discoverTopUps } from './subscription_topups';

const logger = Logger.get('SUBSCRIPTIONS_TOP_UP_LOOP');
const ALERT_TITLE = 'Subscriptions TopUp Loop';

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    priorityAlertsContext.wrapAsyncFunction(ALERT_TITLE, async () => {
      await discoverTopUps(process.env.SUBSCRIPTIONS_RESET == 'true');
    }),
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
