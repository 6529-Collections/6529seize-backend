import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import {
  SubscriptionBalance,
  SubscriptionTopUp
} from '../entities/ISubscription';
import { getAllSubscriptionTopUps } from '../subscriptionsTopUpLoop/alchemy.subscriptions';
import { getAlchemyInstance } from '../alchemy';
import { persistTopUps } from '../subscriptionsTopUpLoop/db.subscriptions_topup';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([]);
  await loadEnv([SubscriptionTopUp, SubscriptionBalance]);
  await replay();
  await unload();
  logger.info('[COMPLETE]');
});

async function replay() {
  logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);
  // logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);

  const alchemy = getAlchemyInstance();
  const toBlock = await alchemy.core.getBlockNumber();
  const subscriptions = await getAllSubscriptionTopUps(alchemy, 0, toBlock);

  logger.info(`[FOUND ${subscriptions.length} NEW TOP UPS]`);

  await persistTopUps(subscriptions);
}
