import { memeLabNfts, memeLabTransactions, memeLabOwners, memeLabExtendedData } from '../meme_lab';
import { loadEnv } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING MEME LAB LOOP]');
  await loadEnv();
  await memeLabLoop();
  console.log(new Date(), '[MEME LAB LOOP COMPLETE]');
};

async function memeLabLoop() {
  await memeLabTransactions();
  await memeLabNfts();
  await memeLabOwners();
  await memeLabExtendedData();
}
