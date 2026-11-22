import { updateOwnerBalances } from './owners_balances';
import { Logger } from '../logging';
import {
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes,
  OwnerBalances,
  OwnerBalancesMemes
} from '../entities/IOwnerBalances';
import * as sentryContext from '../sentry.context';
import { MemesSeason } from '../entities/ISeason';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import { doInDbContext } from '../secrets';
import { appFeatures } from '../app-features';
import { Time } from '../time';
import { sweepHoldingsKeys } from '@/holdings/holdings-key-sweep';
import { readHoldingsKeySweepAction } from '@/holdings/holdings-key-sweep-action';

import { retryPendingSubscriptionCacheInvalidations } from '@/subscriptionsDaily/subscription-cache';

const logger = Logger.get('OWNER_BALANCES_LOOP');

// The key sweep runs on the scheduled minute that is a multiple of this.
const KEY_SWEEP_EVERY_MINUTES = 15;

export const handler = sentryContext.wrapLambdaHandler(
  async (event: unknown) => {
    const sweepAction = readHoldingsKeySweepAction(event);
    return await doInDbContext(
      async () => {
        if (sweepAction) {
          return {
            action: sweepAction.action,
            repair: sweepAction.repair,
            results: await sweepHoldingsKeys({ repair: sweepAction.repair })
          };
        }
        await retryPendingSubscriptionCacheInvalidations();
        await updateOwnerBalances(process.env.OWNER_BALANCES_RESET == 'true');
        if (
          appFeatures.isHoldingsMembershipQueueEnabled() &&
          new Date(Time.currentMillis()).getUTCMinutes() %
            KEY_SWEEP_EVERY_MINUTES ===
            0
        ) {
          try {
            await sweepHoldingsKeys({ repair: true });
          } catch (error) {
            // The balances are written; the next sweep tries again.
            logger.error(`[HOLDINGS KEY SWEEP FAILED] ${error}`);
          }
        }
      },
      {
        logger,
        reportRedisConnectionRecovery: true,
        entities: [
          MemesSeason,
          NFTOwner,
          ConsolidatedNFTOwner,
          OwnerBalances,
          ConsolidatedOwnerBalances,
          OwnerBalancesMemes,
          ConsolidatedOwnerBalancesMemes
        ]
      }
    );
  }
);
