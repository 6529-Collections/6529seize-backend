import {
  NFTFinalSubscription,
  RedeemedSubscription,
  SubscriptionBalance
} from '../entities/ISubscription';
import {
  TransactionsProcessedDistributionBlock,
  TransactionsProcessedSubscriptionsBlock
} from '../entities/ITransactionsProcessing';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { updateDistributionMints } from './distribution';
import { redeemSubscriptions } from './subscriptions';
import { env } from '../env';

const logger = Logger.get('TRANSACTIONS_PROCESSING_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await updateDistributionMints(
        process.env.TRANSACTIONS_PROCESSING_RESET == 'true'
      );
      await redeemSubscriptions(
        env,
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
