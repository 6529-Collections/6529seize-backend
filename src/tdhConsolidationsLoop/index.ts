import { getLastTDH } from '../helpers';
import { consolidateTDH } from '../tdh_consolidation';
import { loadEnv, unload } from '../secrets';
import { ConsolidatedTDH, TDH } from '../entities/ITDH';
import { Logger } from '../logging';
import { ProfileTdh, ProfileTdhLog } from '../entities/IProfileTDH';

const logger = Logger.get('TDH_CONSOLIDATIONS_LOOP');

export const handler = async () => {
  await loadEnv([TDH, ConsolidatedTDH, ProfileTdh, ProfileTdhLog]);
  const force = process.env.TDH_RESET == 'true';
  logger.info(`[RUNNING force=${force}]`);
  await consolidatedTdhLoop();
  await unload();
  logger.info('[COMPLETE]');
};

export async function consolidatedTdhLoop() {
  const lastTDHCalc = getLastTDH();
  await consolidateTDH(lastTDHCalc);
}
