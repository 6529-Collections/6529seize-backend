import { loadEnv, unload } from '../secrets';
import { tdhLoop } from '../tdhLoop/index';
import { Logger } from '../logging';

const logger = Logger.get('TRANSACTIONS_REPLAY_LOOP');

export const handler = async (event?: any, context?: any) => {
  const fromBlock = 16485000;
  const toBlock = undefined;
  logger.info(`[RUNNING] [FROM BLOCK ${fromBlock}] [TO BLOCK ${toBlock}]`);
  await loadEnv();
  // await transactions(fromBlock, toBlock);
  // await findOwnerMetrics();
  await tdhLoop(true);
  await unload();
  logger.info('[COMPLETE]');
};
