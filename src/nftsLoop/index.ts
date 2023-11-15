import { findOwners } from '../owners';
import { nfts } from '../nfts';
import { findMemesExtendedData } from '../memes_extended_data';
import { loadEnv, unload } from '../secrets';
import { NFT } from '../entities/INFT';
import { ConsolidatedOwnerTags, Owner, OwnerTags } from '../entities/IOwner';
import { Logger } from '../logging';

const logger = Logger.get('NFTS_LOOP');

export const handler = async () => {
  logger.info(`[RUNNING]`);
  await loadEnv([NFT, Owner, OwnerTags, ConsolidatedOwnerTags]);
  await nftsLoop();
  await unload();
  logger.info(`[COMPLETE]`);
};

async function nftsLoop() {
  await nfts();
  await findOwners();
  await findMemesExtendedData();
}
