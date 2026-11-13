import { repairWallets, enqueueWalletRepair } from './repair-wallets';
import { updateNftOwners } from './nft_owners';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { MemesSeason } from '../entities/ISeason';
import {
  ConsolidatedNFTOwner,
  NFTOwner,
  NftOwnersSyncState
} from '../entities/INFTOwner';
import { Transaction } from '../entities/ITransaction';
import { doInDbContext } from '../secrets';

const logger = Logger.get('NFT_OWNERS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(
  async (event: unknown) => {
    const wallets = repairWallets(event);
    return doInDbContext(
      async () => {
        if (wallets) return enqueueWalletRepair(wallets);
        await updateNftOwners(process.env.NFT_OWNERS_RESET === 'true');
      },
      {
        logger,
        entities: [
          MemesSeason,
          NFTOwner,
          ConsolidatedNFTOwner,
          NftOwnersSyncState,
          Transaction
        ]
      }
    );
  }
);
