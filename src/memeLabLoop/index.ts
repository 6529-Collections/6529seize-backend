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
import * as sentryContext from "../sentry.context";

const logger = Logger.get('MEME_LAB_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async (event?: any, context?: any) => {
  logger.info('[RUNNING]');
  await loadEnv([LabTransaction, LabNFT, LabExtendedData]);
  await memeLabLoop();
  await unload();
  logger.info('[COMPLETE]');
});

async function memeLabLoop() {
  await memeLabTransactions();
  await memeLabOwners();
  await memeLabNfts();
  await memeLabExtendedData();
}
