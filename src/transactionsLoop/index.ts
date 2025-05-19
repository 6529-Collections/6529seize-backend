import * as sentryContext from '../sentry.context';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';
import { transactionsDiscoveryService } from '../transactions/transactions-discovery.service';
import { parseIntOrNull } from '../helpers';
import { doInDbContext } from '../secrets';

const logger = Logger.get('TRANSACTIONS_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      const contract = process.env.TRANSACTIONS_CONTRACT_ADDRESS as string;
      if (!contract) {
        throw new Error(
          'TRANSACTIONS_CONTRACT_ADDRESS env variable is not set'
        );
      }

      const startingBlock = parseIntOrNull(
        process.env.TRANSACTIONS_LOOP_START_BLOCK
      );
      const endBlock = parseIntOrNull(process.env.TRANSACTIONS_LOOP_END_BLOCK);
      await transactionsDiscoveryService.getAndSaveTransactionsForContract(
        contract,
        startingBlock,
        endBlock
      );
    },
    { logger, entities: [Transaction] }
  );
});
