import { distinct, getLastTDH } from '../helpers';
import { consolidateTDH } from '../tdhLoop/tdh_consolidation';
import {
  ConsolidatedTDH,
  ConsolidatedTDHMemes,
  NftTDH,
  TDH,
  TDHMemes
} from '../entities/ITDH';
import { Logger } from '../logging';
import { Profile } from '../entities/IProfile';
import { fetchAllConsolidationAddresses } from '../db';
import * as sentryContext from '../sentry.context';
import { NextGenTokenTDH } from '../entities/INextGen';
import {
  AggregatedActivity,
  AggregatedActivityMemes,
  ConsolidatedAggregatedActivity,
  ConsolidatedAggregatedActivityMemes
} from '../entities/IAggregatedActivity';
import { ConsolidatedNFTOwner, NFTOwner } from '../entities/INFTOwner';
import {
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes,
  OwnerBalances,
  OwnerBalancesMemes
} from '../entities/IOwnerBalances';
import { consolidateActivity } from '../aggregatedActivityLoop/aggregated_activity';
import { consolidateNftOwners } from '../nftOwnersLoop/nft_owners';
import { consolidateOwnerBalances } from '../ownersBalancesLoop/owners_balances';
import { updateTDH } from '../tdhLoop/tdh';
import { MemesSeason } from '../entities/ISeason';
import { doInDbContext } from '../secrets';

const logger = Logger.get('TDH_CONSOLIDATIONS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const force = process.env.TDH_RESET == 'true';
      logger.info(`[force=${force}]`);
      await consolidatedTdhLoop();
    },
    {
      logger,
      entities: [
        TDH,
        ConsolidatedTDH,
        NextGenTokenTDH,
        TDHMemes,
        ConsolidatedTDHMemes,
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
      ]
    }
  );
});

async function consolidatedTdhLoop() {
  const lastTDHCalc = getLastTDH();
  const consolidationAddresses: { wallet: string }[] =
    await fetchAllConsolidationAddresses();

  const distinctWallets = new Set<string>();
  consolidationAddresses.forEach((address) => {
    distinctWallets.add(address.wallet);
  });
  const walletsArray = distinct(consolidationAddresses.map((it) => it.wallet));

  await updateTDH(lastTDHCalc, walletsArray);
  await consolidateTDH(lastTDHCalc, walletsArray);

  await consolidateNftOwners(distinctWallets);
  await consolidateOwnerBalances(distinctWallets);
  await consolidateActivity(distinctWallets);
}
