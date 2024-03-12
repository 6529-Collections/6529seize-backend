import { consolidateOwnerBalances, findOwnerBalances } from './owners_balances';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import {
  OwnerBalancesMemes,
  OwnerBalances,
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes
} from '../entities/IOwnerBalances';
import { Time } from '../time';
import * as sentryContext from '../sentry.context';
import { MemesSeason } from '../entities/ISeason';

const logger = Logger.get('OWNER_BALANCES_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  const timer = Time.now();
  logger.info('[RUNNING]');
  await loadEnv([
    MemesSeason,
    OwnerBalances,
    ConsolidatedOwnerBalances,
    OwnerBalancesMemes,
    ConsolidatedOwnerBalancesMemes
  ]);
  await ownersBalancesLoop();
  await unload();
});

async function ownersBalancesLoop() {
  await findOwnerBalances(process.env.ONWER_BALANCES_RESET == 'true');
  await consolidateOwnerBalances();
}
