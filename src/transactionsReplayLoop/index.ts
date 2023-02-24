import { loadEnv, unload } from '../secrets';
import { transactions } from '../transactionsLoop/index';
import { findOwnerMetrics } from '../owner_metrics';
import { tdhLoop } from '../tdhLoop/index';

export const handler = async (event?: any, context?: any) => {
  const fromBlock = 16485000;
  const toBlock = undefined;
  console.log(
    '[RUNNING REPLAY-TRANSACTIONS LOOP]',
    `[FROM BLOCK ${fromBlock}]`,
    `[TO BLOCK ${toBlock}]`
  );
  await loadEnv();
  // await transactions(fromBlock, toBlock);
  // await findOwnerMetrics();
  await tdhLoop(true);
  await unload();
  console.log('[REPLAY-TRANSACTIONS LOOP COMPLETE]');
};
