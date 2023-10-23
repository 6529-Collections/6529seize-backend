import { findOwners } from '../owners';
import { nfts } from '../nfts';
import { findMemesExtendedData } from '../memes_extended_data';
import { loadEnv, unload } from '../secrets';
import { NFT } from '../entities/INFT';
import { ConsolidatedOwnerTags, Owner, OwnerTags } from '../entities/IOwner';

export const handler = async () => {
  console.log(new Date(), '[RUNNING NFTS LOOP]');
  await loadEnv([NFT, Owner, OwnerTags, ConsolidatedOwnerTags]);
  await nftsLoop();
  await unload();
  console.log(new Date(), '[NFTS LOOP COMPLETE]');
};

async function nftsLoop() {
  await nfts();
  await findOwners();
  await findMemesExtendedData();
}
