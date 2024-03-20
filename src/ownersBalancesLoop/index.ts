import { findOwnerBalances } from './owners_balances';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import {
  OwnerBalancesMemes,
  OwnerBalances,
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes
} from '../entities/IOwnerBalances';
import * as sentryContext from '../sentry.context';
import { MemesSeason } from '../entities/ISeason';
import { Time } from '../time';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';

const logger = Logger.get('OWNER_BALANCES_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  const start = Time.now();
  logger.info('[RUNNING]');
  await loadEnv([
    MemesSeason,
    NFTOwner,
    ConsolidatedNFTOwner,
    OwnerBalances,
    ConsolidatedOwnerBalances,
    OwnerBalancesMemes,
    ConsolidatedOwnerBalancesMemes
  ]);
  await findOwnerBalances(process.env.OWNER_BALANCES_RESET == 'true');
  await unload();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
});
