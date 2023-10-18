import { findOwnerTags } from '../owners_tags';
import { loadEnv, unload } from '../secrets';
import { NFT } from '../entities/INFT';
import { ConsolidatedOwnerTags, Owner, OwnerTags } from '../entities/IOwner';

export const handler = async () => {
  console.log(new Date(), '[RUNNING OWNER TAGS LOOP]');
  await loadEnv([NFT, Owner, OwnerTags, ConsolidatedOwnerTags]);
  await ownersLoop();
  await unload();
  console.log(new Date(), '[OWNER TAGS LOOP COMPLETE]');
};

async function ownersLoop() {
  await findOwnerTags();
}
