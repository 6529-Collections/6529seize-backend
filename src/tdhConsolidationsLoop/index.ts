import { getLastTDH } from '../helpers';
import { consolidateTDH } from '../tdhLoop/tdh_consolidation';
import { loadEnv, unload } from '../secrets';
import {
  ConsolidatedTDH,
  ConsolidatedTDHMemes,
  NftTDH,
  TDH,
  TDHMemes
} from '../entities/ITDH';
import { Logger } from '../logging';
import { Time } from '../time';
import { Profile } from '../entities/IProfile';
import { fetchAllConsolidationAddresses } from '../db';
import * as sentryContext from '../sentry.context';
import { NextGenTokenTDH } from '../entities/INextGen';
import { CommunityMember } from '../entities/ICommunityMember';
import {
  AggregatedActivity,
  ConsolidatedAggregatedActivity,
  AggregatedActivityMemes,
  ConsolidatedAggregatedActivityMemes
} from '../entities/IAggregatedActivity';
import { NFTOwner, ConsolidatedNFTOwner } from '../entities/INFTOwner';
import {
  OwnerBalances,
  OwnerBalancesMemes,
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes
} from '../entities/IOwnerBalances';
import { consolidateActivity } from '../aggregatedActivityLoop/aggregated_activity';
import { consolidateNftOwners } from '../nftOwnersLoop/nft_owners';
import { consolidateOwnerBalances } from '../ownersBalancesLoop/owners_balances';
import { findTDH } from '../tdhLoop/tdh';
import { MemesSeason } from '../entities/ISeason';

const logger = Logger.get('TDH_CONSOLIDATIONS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  const start = Time.now();
  await loadEnv([
    TDH,
    ConsolidatedTDH,
    NextGenTokenTDH,
    TDHMemes,
    ConsolidatedTDHMemes,
    CommunityMember,
    Profile,
    NFTOwner,
    ConsolidatedNFTOwner,
    OwnerBalances,
    OwnerBalancesMemes,
    ConsolidatedOwnerBalances,
    ConsolidatedOwnerBalancesMemes,
    AggregatedActivity,
    ConsolidatedAggregatedActivity,
    AggregatedActivityMemes,
    ConsolidatedAggregatedActivityMemes,
    NftTDH,
    MemesSeason
  ]);
  const force = process.env.TDH_RESET == 'true';
  logger.info(`[RUNNING force=${force}]`);
  await consolidatedTdhLoop();
  await unload();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
});

async function consolidatedTdhLoop() {
  const lastTDHCalc = getLastTDH();
  const consolidationAddresses: { wallet: string }[] =
    await fetchAllConsolidationAddresses();

  const distinctWallets = new Set<string>();
  consolidationAddresses.forEach((address) => {
    distinctWallets.add(address.wallet);
  });
  const walletsArray = Array.from(distinctWallets);

  await findTDH(lastTDHCalc, walletsArray);
  await consolidateTDH(lastTDHCalc, walletsArray);

  await consolidateNftOwners(distinctWallets);
  await consolidateOwnerBalances(distinctWallets);
  await consolidateActivity(distinctWallets);
}
