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
import { NFTOwner } from '../entities/INFTOwner';
import { getDataSource } from '../db';
import { DISTRIBUTION_NORMALIZED_TABLE } from '../constants';
import { sqlExecutor } from '../sql-executor';
import { NFT_MODE, processNFTs } from './nfts';
import { resolveEnumOrThrow } from '../helpers';
import {
  findMemesExtendedData,
  findMemeLabExtendedData
} from './nft_extended_data';
import { Transaction } from '../entities/ITransaction';
import { updateDistributionInfoFor } from './nft_distribution';
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
  const modeEnum = resolveEnumOrThrow(NFT_MODE, mode);
  await processNFTs(modeEnum);
  await findMemesExtendedData();
  await findMemeLabExtendedData();
  await updateDistributionInfoFor(NFT);
  await updateDistributionInfoFor(LabNFT);
}
