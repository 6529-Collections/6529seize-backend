import { doInDbContext } from '@/secrets';
import {
  LabExtendedData,
  LabNFT,
  MemesExtendedData,
  NFT
} from '@/entities/INFT';
import { Logger } from '@/logging';
import * as sentryContext from '@/sentry.context';
import { MemesSeason } from '@/entities/ISeason';
import { MemesMintStat } from '@/entities/IMemesMintStat';
import { NFTOwner } from '@/entities/INFTOwner';
import { NFT_MODE, processNFTs } from '@/nftsLoop/nfts';
import * as priorityAlertsContext from '@/priority-alerts.context';
import {
  findMemeLabExtendedData,
  findMemesExtendedData
} from '@/nftsLoop/nft_extended_data';
import { Transaction } from '@/entities/ITransaction';
import { RedeemedSubscription } from '@/entities/ISubscription';
import { updateDistributionInfoFor } from '@/nftsLoop/nft_distribution';
import { enums } from '@/enums';

const logger = Logger.get('NFTS_LOOP');
const ALERT_TITLE = 'NFTs Loop';

export const handler = sentryContext.wrapLambdaHandler(async (event) => {
  await doInDbContext(
    priorityAlertsContext.wrapAsyncFunction(ALERT_TITLE, async () => {
      await nftsLoop(event?.mode);
    }),
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
  if (modeEnum === NFT_MODE.AUDIT) {
    return;
  }
  await findMemesExtendedData();
  await findMemeLabExtendedData();
  await updateDistributionInfoFor(NFT);
  await updateDistributionInfoFor(LabNFT);
}
