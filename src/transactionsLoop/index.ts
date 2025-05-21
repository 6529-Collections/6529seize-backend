import * as sentryContext from '../sentry.context';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';
import { transactionsDiscoveryService } from '../transactions/transactions-discovery.service';
import { doInDbContext } from '../secrets';
import { numbers } from '../numbers';

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

      const startingBlock = numbers.parseIntOrNull(
        process.env.TRANSACTIONS_LOOP_START_BLOCK
      );
      const endBlock = numbers.parseIntOrNull(
        process.env.TRANSACTIONS_LOOP_END_BLOCK
      );
      await transactionsDiscoveryService.getAndSaveTransactionsForContract(
        contract,
        startingBlock,
        endBlock
      );
    },
    { logger, entities: [Transaction] }
  );
});
