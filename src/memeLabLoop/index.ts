import { LabExtendedData, LabNFT } from '../entities/INFT';
import { memeLabExtendedData, memeLabNfts, memeLabOwners } from '../meme_lab';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';

const logger = Logger.get('MEME_LAB_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info('[RUNNING]');
  await loadEnv([LabNFT, LabExtendedData]);
  await memeLabLoop();
  await unload();
  logger.info('[COMPLETE]');
});

async function memeLabLoop() {
  await memeLabOwners();
  await memeLabNfts();
  await memeLabExtendedData();
}
