import { doInDbContext } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { updateNftOwners } from '../nftOwnersLoop/nft_owners';
import { NFTOwner, ConsolidatedNFTOwner } from '../entities/INFTOwner';
import { MemesSeason } from '../entities/ISeason';
import { updateOwnerBalances } from '../ownersBalancesLoop/owners_balances';
import {
  ConsolidatedOwnerBalances,
  ConsolidatedOwnerBalancesMemes,
  OwnerBalances,
  OwnerBalancesMemes
} from '../entities/IOwnerBalances';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await replay();
    },
    {
      logger,
      entities: [
        MemesSeason,
        NFTOwner,
        ConsolidatedNFTOwner,
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
});

async function replay() {
  // logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);
  await updateNftOwners(true);
  await updateOwnerBalances(true);
}
