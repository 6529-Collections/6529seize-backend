import { LabExtendedData, LabNFT } from '../entities/INFT';
import { memeLabExtendedData, memeLabNfts } from '../meme_lab';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { NFTOwner } from '../entities/INFTOwner';

const logger = Logger.get('MEME_LAB_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info('[RUNNING]');
  await loadEnv([LabNFT, LabExtendedData, NFTOwner]);
  await memeLabLoop();
  await unload();
  logger.info('[COMPLETE]');
});

async function memeLabLoop() {
  await memeLabNfts();
  await memeLabExtendedData();
}
