import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { fetchAllAutoSubscriptions } from '../subscriptionsDaily/db.subscriptions';
import {
  SubscriptionMode,
  NFTSubscription,
  NFTFinalSubscription,
  SubscriptionLog,
  SubscriptionBalance
} from '../entities/ISubscription';
import { createForMemeId } from '../subscriptionsDaily/subscriptions';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([
    SubscriptionMode,
    NFTSubscription,
    NFTFinalSubscription,
    SubscriptionLog,
    SubscriptionBalance
  ]);
  await replay();
  await unload();
  logger.info('[COMPLETE]');
});

async function replay() {
  // logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);
  const currentAutoSubscriptions = await fetchAllAutoSubscriptions();

  await createForMemeId(223, currentAutoSubscriptions);
}
