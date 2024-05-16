import { getLastTDH } from '../helpers';
import { updateTDH } from './tdh';
import { loadEnv } from '../secrets';
import { Logger } from '../logging';
import { Time } from '../time';

const logger = Logger.get('TDH_LOOP');

export const handler = async () => {
  const start = Time.now();
  logger.info(`[RUNNING]`);

  await loadEnv();
  await tdh();

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};

async function tdh() {
  const lastTDHCalc = getLastTDH();
  await updateTDH(lastTDHCalc);
}
