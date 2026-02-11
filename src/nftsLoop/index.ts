import { doInDbContext } from '../secrets';
import {
  LabExtendedData,
  LabNFT,
  MemesExtendedData,
  NFT
} from '../entities/INFT';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { MemesSeason } from '../entities/ISeason';
import { MemesMintStat } from '../entities/IMemesMintStat';
import { NFTOwner } from '../entities/INFTOwner';
import { NFT_MODE, processNFTs } from './nfts';
import {
  findMemeLabExtendedData,
  findMemesExtendedData
} from './nft_extended_data';
import { Transaction } from '../entities/ITransaction';
import { RedeemedSubscription } from '../entities/ISubscription';
import { updateDistributionInfoFor } from './nft_distribution';
import { enums } from '../enums';

const logger = Logger.get('NFTS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async (event) => {
  await doInDbContext(
    async () => {
      await nftsLoop(event?.mode);
    },
    {
      logger,
      entities: [
        NFT,
        MemesExtendedData,
        MemesSeason,
        NFTOwner,
        LabNFT,
        LabExtendedData,
        Transaction,
        MemesMintStat,
        RedeemedSubscription
      ]
    }
  );
});

async function nftsLoop(mode?: string) {
  const modeEnum = enums.resolveOrThrow(NFT_MODE, mode);
  await processNFTs(modeEnum);
  await findMemesExtendedData();
  await findMemeLabExtendedData();
  await updateDistributionInfoFor(NFT);
  await updateDistributionInfoFor(LabNFT);
}
