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
} from '@/nftsLoop/nft-extended-data';
import { Transaction } from '@/entities/ITransaction';
import { RedeemedSubscription } from '@/entities/ISubscription';
import { updateDistributionInfoFor } from '@/nftsLoop/nft-distribution';
import { enums } from '@/enums';
import { S3UploaderOutboxEntity } from '@/entities/IS3UploaderOutbox';

const logger = Logger.get('NFTS_LOOP');
const ALERT_TITLE = 'NFTs Loop';

export const handler = sentryContext.wrapLambdaHandler(async (event) => {
  const modeEnum = enums.resolveOrThrow(NFT_MODE, event?.mode);
  logger.info(`[${modeEnum.toUpperCase()}] [RUNNING]`);
  try {
    await doInDbContext(
      priorityAlertsContext.wrapAsyncFunction(ALERT_TITLE, async () => {
        await nftsLoop(modeEnum);
      }),
      {
        entities: [
          NFT,
          MemesExtendedData,
          MemesSeason,
          NFTOwner,
          LabNFT,
          LabExtendedData,
          Transaction,
          MemesMintStat,
          RedeemedSubscription,
          S3UploaderOutboxEntity
        ]
      }
    );
  } finally {
    logger.info(`[${modeEnum.toUpperCase()}] [FINISHED]`);
  }
});

async function nftsLoop(mode: NFT_MODE) {
  await processNFTs(mode);
  if (mode === NFT_MODE.AUDIT) {
    return;
  }
  await findMemesExtendedData();
  await findMemeLabExtendedData();
  await updateDistributionInfoFor(NFT);
  await updateDistributionInfoFor(LabNFT);
}
