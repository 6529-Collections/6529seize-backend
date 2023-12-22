import {
  consolidateOwnerBalances,
  findOwnerBalances
} from '../owners_balances';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import {
  OwnerBalancesMemes,
  OwnerBalances,
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes
} from '../entities/IOwnerBalances';
import { OwnerTags, ConsolidatedOwnerTags } from '../entities/IOwner';
import { Time } from '../time';

const logger = Logger.get('OWNER_BALANCES_LOOP');

export const handler = async () => {
  const timer = Time.now();
  logger.info('[RUNNING]');
  await loadEnv([
    OwnerTags,
    ConsolidatedOwnerTags,
    OwnerBalances,
    ConsolidatedOwnerBalances,
    OwnerBalancesMemes,
    ConsolidatedOwnerBalancesMemes
  ]);
  await ownersBalancesLoop();
  await unload();
  logger.info(`[COMPLETED IN ${timer.printTimeDiff()}]`);
};

async function ownersBalancesLoop() {
  await findOwnerBalances(process.env.ONWER_BALANCES_RESET == 'true');
  await consolidateOwnerBalances();
}
