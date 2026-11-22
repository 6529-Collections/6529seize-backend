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
import { appFeatures } from '../app-features';
import { replayTopUpLoopDeferredWrites } from '../subscription-key-width/subscription-deferred-replay';

const logger = Logger.get('SUBSCRIPTIONS_TOP_UP_LOOP');
const ALERT_TITLE = 'Subscriptions TopUp Loop';

/** A failed replay is logged and never stops the top-up scan. */
async function replayDeferredWrites() {
  try {
    const summary = await replayTopUpLoopDeferredWrites();
    if (summary.done || summary.skipped || summary.requeued || summary.failed) {
      logger.info(`[DEFERRED WRITES REPLAYED] ${JSON.stringify(summary)}`);
    }
  } catch (error) {
    logger.error('[DEFERRED WRITES REPLAY FAILED]', error);
  }
}

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    priorityAlertsContext.wrapAsyncFunction(ALERT_TITLE, async () => {
      if (appFeatures.isSubscriptionDeferredReplayEnabled()) {
        await replayDeferredWrites();
      }
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
