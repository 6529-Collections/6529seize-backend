import { loadEnv, unload } from '../secrets';
import { LabTransaction } from '../entities/ITransaction';
import { transactions } from '../meme_lab';

export const handler = async (event?: any, context?: any) => {
  const fromBlock = 0;
  const toBlock = undefined;
  console.log(
    '[RUNNING REPLAY-TRANSACTIONS LOOP]',
    `[FROM BLOCK ${fromBlock}]`,
    `[TO BLOCK ${toBlock}]`
  );
  await loadEnv([LabTransaction]);
  await transactions(fromBlock, toBlock);
  await unload();
  console.log('[REPLAY-TRANSACTIONS LOOP COMPLETE]');
};
