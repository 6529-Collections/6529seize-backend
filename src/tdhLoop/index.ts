import { getLastTDH } from '../helpers';
import { updateTDH } from './tdh';
import { loadEnv, unload } from '../secrets';
import { ConsolidatedTDH, TDH, TDHBlock } from '../entities/ITDH';
import { NFT } from '../entities/INFT';
import { Logger } from '../logging';
import { NFTOwner } from '../entities/INFTOwner';
import { Time } from '../time';

const logger = Logger.get('TDH_LOOP');

export const handler = async () => {
  const start = Time.now();
  logger.info(`[RUNNING]`);

  await loadEnv([TDH, ConsolidatedTDH, NFT, NFTOwner, TDHBlock]);
  await tdh();
  await unload();

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};

async function tdh() {
  const lastTDHCalc = getLastTDH();
  await updateTDH(lastTDHCalc);
}
