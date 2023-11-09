import { loadEnv, unload } from '../secrets';
import { transactions } from '../transactionsLoop/index';

export const handler = async (event?: any, context?: any) => {
  const fromBlock = 0;
  const toBlock = 16867180;
  console.log(
    '[RUNNING REPLAY-TRANSACTIONS LOOP]',
    `[FROM BLOCK ${fromBlock}]`,
    `[TO BLOCK ${toBlock}]`
  );
  await loadEnv();
  await transactions(fromBlock, toBlock);
  await unload();
  console.log('[REPLAY-TRANSACTIONS LOOP COMPLETE]');
};
