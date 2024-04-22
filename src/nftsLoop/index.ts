import { nfts } from './nfts';
import { loadEnv, unload } from '../secrets';
import { NFT } from '../entities/INFT';
import { Logger } from '../logging';

const logger = Logger.get('NFTS_LOOP');

export const handler = async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([NFT]);
  await nfts();
  await unload();
  logger.info(`[COMPLETE]`);
};
