import { LabExtendedData, LabNFT } from '../entities/INFT';
import { LabTransaction } from '../entities/ITransaction';
import {
  memeLabNfts,
  memeLabTransactions,
  memeLabOwners,
  memeLabExtendedData
} from '../meme_lab';
import { loadEnv, unload } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING MEME LAB LOOP]');
  await loadEnv([LabTransaction, LabNFT, LabExtendedData]);
  await memeLabLoop();
  await unload();
  console.log(new Date(), '[MEME LAB LOOP COMPLETE]');
};

async function memeLabLoop() {
  await memeLabTransactions();
  await memeLabOwners();
  await memeLabNfts();
  await memeLabExtendedData();
}
