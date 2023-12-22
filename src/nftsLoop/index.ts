import { findOwners } from '../owners';
import { nfts } from '../nfts';
import { findMemesExtendedData } from '../memes_extended_data';
import { loadEnv, unload } from '../secrets';
import { NFT } from '../entities/INFT';
import { Owner } from '../entities/IOwner';
import { Logger } from '../logging';
import { MemesSeason } from '../entities/ISeason';
import { Time } from '../time';

const logger = Logger.get('NFTS_LOOP');

export const handler = async () => {
  const timer = Time.now();
  logger.info(`[RUNNING]`);
  await loadEnv([NFT, Owner, MemesSeason]);
  await nftsLoop();
  await unload();
  logger.info(`[COMPLETED IN ${timer.printTimeDiff()}]`);
};

async function nftsLoop() {
  // await nfts();
  await findOwners();
  await findMemesExtendedData();
}
