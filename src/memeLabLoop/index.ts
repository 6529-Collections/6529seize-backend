import { LabExtendedData, LabNFT } from '../entities/INFT';
import { LabTransaction } from '../entities/ITransaction';
import {
  memeLabNfts,
  memeLabTransactions,
  memeLabOwners,
  memeLabExtendedData
} from '../meme_lab';
import { loadEnv, unload } from '../secrets';
import { Logger } from '../logging';

const logger = Logger.get('MEME_LAB_LOOP');

export const handler = async (event?: any, context?: any) => {
  logger.info('[RUNNING]');
  await loadEnv([LabTransaction, LabNFT, LabExtendedData]);
  await memeLabLoop();
  await unload();
  logger.info('[COMPLETE]');
};

async function memeLabLoop() {
  // await memeLabTransactions();
  // await memeLabOwners();
  await memeLabNfts();
  // await memeLabExtendedData();
}
