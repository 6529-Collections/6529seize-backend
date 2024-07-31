import { LabExtendedData, LabNFT } from '../entities/INFT';
import { memeLabExtendedData, memeLabNfts } from '../meme_lab';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { NFTOwner } from '../entities/INFTOwner';
import { doInDbContext } from '../secrets';

const logger = Logger.get('MEME_LAB_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await memeLabLoop();
    },
    {
      entities: [LabNFT, LabExtendedData, NFTOwner],
      logger
    }
  );
});

async function memeLabLoop() {
  await memeLabNfts();
  await memeLabExtendedData();
}
