import { loadEnv, unload } from '../secrets';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';
import { transactionsDiscoveryService } from '../transactions/transactions-discovery.service';
import { parseNumberOrNull } from '../helpers';

const logger = Logger.get('TRANSACTIONS_LOOP');

export const handler = async (contract: string) => {
  await loadEnv([Transaction]);
  logger.info('[RUNNING]');

  const startingBlock = parseNumberOrNull(
    process.env.TRANSACTIONS_LOOP_START_BLOCK
  );
  const endBlock = parseNumberOrNull(process.env.TRANSACTIONS_LOOP_END_BLOCK);
  await transactionsDiscoveryService.getAndSaveTransactionsForContract(
    contract,
    startingBlock,
    endBlock
  );
  await unload();
  logger.info('[COMPLETE]');
};
