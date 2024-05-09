import { fetchLatestTDHBDate } from '../db';
import { getLastTDH } from '../helpers';
import { updateTDH } from './tdh';
import { loadEnv, unload } from '../secrets';
import { ConsolidatedTDH, TDH, TDHBlock } from '../entities/ITDH';
import { NFT } from '../entities/INFT';
import { Logger } from '../logging';
import { NFTOwner } from '../entities/INFTOwner';

const logger = Logger.get('TDH_LOOP');

export const handler = async () => {
  await loadEnv([TDH, ConsolidatedTDH, NFT, NFTOwner, TDHBlock]);
  logger.info(`[RUNNING]`);
  await tdh();
  await unload();
  logger.info('[COMPLETE]');
};

async function tdh() {
  const lastTDHCalc = getLastTDH();
  await updateTDH(lastTDHCalc);
}
