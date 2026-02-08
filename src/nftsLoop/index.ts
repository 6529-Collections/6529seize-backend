import {
  LabExtendedData,
  LabNFT,
  MemesExtendedData,
  NFT
} from '../entities/INFT';
import { NFTOwner } from '../entities/INFTOwner';
import { MemesSeason } from '../entities/ISeason';
import { Transaction } from '../entities/ITransaction';
import { enums } from '../enums';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { updateDistributionInfoFor } from './nft_distribution';
import {
  findMemeLabExtendedData,
  findMemesExtendedData
} from './nft_extended_data';
import { NFT_MODE, processNFTs } from './nfts';

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
        Transaction
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
