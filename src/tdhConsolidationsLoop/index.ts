import { distinct, getLastTDH } from '../helpers';
import { consolidateTDH } from '../tdhLoop/tdh_consolidation';
import { loadEnv, unload } from '../secrets';
import { ConsolidatedTDH, NftTDH, TDH } from '../entities/ITDH';
import { Logger } from '../logging';
import { Time } from '../time';
import { fetchAllConsolidationAddresses } from '../db';
import { NFTOwner } from '../entities/INFTOwner';
import { updateTDH } from '../tdhLoop/tdh';

const logger = Logger.get('TDH_CONSOLIDATIONS_LOOP');

export const handler = async () => {
  const start = Time.now();
  await loadEnv([TDH, ConsolidatedTDH, NFTOwner, NftTDH]);
  const force = process.env.TDH_RESET == 'true';
  logger.info(`[RUNNING force=${force}]`);
  await consolidatedTdhLoop();
  await unload();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};

async function consolidatedTdhLoop() {
  const lastTDHCalc = getLastTDH();
  const consolidationAddresses: { wallet: string }[] =
    await fetchAllConsolidationAddresses();

  const walletsArray = distinct(consolidationAddresses.map((it) => it.wallet));

  await updateTDH(lastTDHCalc, walletsArray);
  await consolidateTDH(walletsArray);
}
