import { findOwnerTags } from '../owners_tags';
import { loadEnv, unload } from '../secrets';
import { NFT } from '../entities/INFT';
import { ConsolidatedOwnerTags, Owner, OwnerTags } from '../entities/IOwner';
import { Logger } from '../logging';

const logger = Logger.get('OWNER_TAGS_LOOP');

export const handler = async () => {
  logger.info('[RUNNING]');
  await loadEnv([NFT, Owner, OwnerTags, ConsolidatedOwnerTags]);
  await ownersLoop();
  await unload();
  logger.info('[COMPLETE]');
};

async function ownersLoop() {
  await findOwnerTags();
}
