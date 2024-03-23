import { nfts } from './nfts';
import { findMemesExtendedData } from './memes_extended_data';
import { loadEnv, unload } from '../secrets';
import { MemesExtendedData, NFT } from '../entities/INFT';
import { Logger } from '../logging';
import * as sentryContext from '../sentry.context';
import { MemesSeason } from '../entities/ISeason';
import { NFTOwner } from '../entities/INFTOwner';

const logger = Logger.get('NFTS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([NFT, MemesExtendedData, MemesSeason, NFTOwner]);
  await nftsLoop();
  await unload();
  logger.info(`[COMPLETE]`);
});

async function nftsLoop() {
  await nfts();
  await findMemesExtendedData();
}
