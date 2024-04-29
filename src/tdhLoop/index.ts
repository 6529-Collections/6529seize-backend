import { fetchLatestTDHBDate } from '../db';
import { getLastTDH } from '../helpers';
import { updateTDH } from './tdh';
import { consolidateTDH } from './tdh_consolidation';
import { loadEnv, unload } from '../secrets';
import { ConsolidatedTDH, TDH, TDHBlock } from '../entities/ITDH';
import { NFT } from '../entities/INFT';
import { Logger } from '../logging';
import { Time } from '../time';
import { NFTOwner } from '../entities/INFTOwner';

const logger = Logger.get('TDH_LOOP');

export const handler = async () => {
  await loadEnv([TDH, ConsolidatedTDH, NFT, NFTOwner, TDHBlock]);
  const force = process.env.TDH_RESET == 'true';
  logger.info(`[RUNNING force=${force}]`);
  await tdh(force);
  await unload();
  logger.info('[COMPLETE]');
};

async function tdh(force?: boolean) {
  const lastTDHCalc = getLastTDH();

  const lastTdhDB = await fetchLatestTDHBDate();
  const lastTdhFromNow = lastTdhDB.diffFromNow();

  if (lastTdhFromNow.gt(Time.hours(24)) || force) {
    await updateTDH(lastTDHCalc);
    await consolidateTDH();
  } else {
    logger.info(
      `[TODAY'S TDH ALREADY CALCULATED ${lastTdhFromNow} ago] [SKIPPING...]`
    );
  }
}
