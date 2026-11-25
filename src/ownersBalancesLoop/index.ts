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

// The key sweep runs once an hour, on the scheduled run at this minute.
const KEY_SWEEP_MINUTE = 0;

export const handler = sentryContext.wrapLambdaHandler(
  async (event: unknown) => {
    const sweepAction = readHoldingsKeySweepAction(event);
    return await doInDbContext(
      async () => {
        if (sweepAction) {
          return {
            action: sweepAction.action,
            repair: sweepAction.repair,
            ...(await sweepHoldingsKeys({ repair: sweepAction.repair }))
          };
        }
        // The minute the scheduled run started, so a balances pass that ends
        // after it still sweeps.
        const startedAtMinute = new Date(Time.currentMillis()).getUTCMinutes();
        await retryPendingSubscriptionCacheInvalidations();
        await updateOwnerBalances(process.env.OWNER_BALANCES_RESET == 'true');
        if (
          appFeatures.isHoldingsMembershipQueueEnabled() &&
          startedAtMinute === KEY_SWEEP_MINUTE
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
