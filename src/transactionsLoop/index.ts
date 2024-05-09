import { loadEnv, unload } from '../secrets';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';
import { transactionsDiscoveryService } from '../transactions/transactions-discovery.service';
import { parseNumberOrNull } from '../helpers';
import { Time } from '../time';

const logger = Logger.get('TRANSACTIONS_LOOP');

export const handler = async (contract: string) => {
  const start = Time.now();
  logger.info(`[RUNNING FOR CONTRACT ${contract}]`);

  await loadEnv([Transaction]);

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

  const diff = start.diffFromNow().formatAsDuration();
  logger.info(`[COMPLETE IN ${diff}]`);
};
