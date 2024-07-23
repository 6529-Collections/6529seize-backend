import { updateDistributionMints } from './distribution';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import {
  TransactionsProcessedDistributionBlock,
  TransactionsProcessedSubscriptionsBlock
} from '../entities/ITransactionsProcessing';
import { redeemSubscriptions } from './subscriptions';
import {
  NFTFinalSubscription,
  RedeemedSubscription,
  SubscriptionBalance
} from '../entities/ISubscription';
import { doInDbContext } from '../secrets';

const logger = Logger.get('TRANSACTIONS_PROCESSING_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await updateDistributionMints(
        process.env.TRANSACTIONS_PROCESSING_RESET == 'true'
      );
      await redeemSubscriptions(
        process.env.TRANSACTIONS_PROCESSING_RESET == 'true'
      );
    },
    {
      logger,
      entities: [
        RedeemedSubscription,
        NFTFinalSubscription,
        SubscriptionBalance,
        TransactionsProcessedDistributionBlock,
        TransactionsProcessedSubscriptionsBlock
      ]
    }
  );
});
