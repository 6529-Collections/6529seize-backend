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
import { NftsLoopHealth, observeNftPublication } from '@/nftsLoop/loop-health';

const logger = Logger.get('NFTS_LOOP');
const ALERT_TITLE = 'NFTs Loop';

export const handler = sentryContext.wrapLambdaHandler(
  async (event, context) => {
    const modeEnum = enums.resolveOrThrow(NFT_MODE, event?.mode);
    const health = new NftsLoopHealth(modeEnum);
    const observePublication = async () => {
      if (
        !context?.getRemainingTimeInMillis ||
        context.getRemainingTimeInMillis() > 5000
      )
        await observeNftPublication();
    };
    logger.info(`[${modeEnum.toUpperCase()}] [RUNNING]`);
    try {
      await doInDbContext(
        priorityAlertsContext.wrapAsyncFunction(ALERT_TITLE, async () => {
          await observePublication();
          try {
            await nftsLoop(modeEnum, health);
            health.completed();
          } finally {
            await observePublication();
          }
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
  }
);

async function nftsLoop(mode: NFT_MODE, health: NftsLoopHealth) {
  await processNFTs(mode, health);
  if (mode === NFT_MODE.AUDIT) {
    return;
  }
  await findMemesExtendedData();
  health.committed();
  await findMemeLabExtendedData();
  health.committed();
  await updateDistributionInfoFor(NFT);
  health.committed();
  await updateDistributionInfoFor(LabNFT);
  health.committed();
}
