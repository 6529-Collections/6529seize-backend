import { distinct, getLastTDH } from '../helpers';
import { loadEnv } from '../secrets';
import { Logger } from '../logging';
import { Time } from '../time';
import { fetchAllConsolidationAddresses } from '../db';
import { updateTDH } from '../tdhLoop/tdh';

const logger = Logger.get('TDH_CONSOLIDATIONS_LOOP');

export const handler = async () => {
  const start = Time.now();
  await loadEnv();
  logger.info(`[RUNNING]`);
  await consolidatedTdhLoop();
  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};

async function consolidatedTdhLoop() {
  const lastTDHCalc = getLastTDH();
  const consolidationAddresses: { wallet: string }[] =
    await fetchAllConsolidationAddresses();

  const walletsArray = distinct(consolidationAddresses.map((it) => it.wallet));

  await updateTDH(lastTDHCalc, walletsArray);
}
