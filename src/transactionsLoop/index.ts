import * as sentryContext from '../sentry.context';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';
import { transactionsDiscoveryService } from '../transactions/transactions-discovery.service';
import { doInDbContext } from '../secrets';
import { numbers } from '../numbers';
import { getDropForgePolicy } from '@/drop-forge/drop-forge.policy';
import { TransactionScanCheckpoint } from '@/entities/ITransactionScanCheckpoint';
import { checkpointTransactionScan } from '@/transactions/transaction-scan-checkpoint';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';

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
      const policy = process.env.DROP_FORGE_STAGE ? getDropForgePolicy() : null;
      if (
        policy?.chainId === 1 &&
        contract.toLowerCase() === policy.creator.toLowerCase() &&
        startingBlock === null &&
        endBlock === null
      ) {
        await checkpointTransactionScan(
          policy.chainId,
          contract,
          getEthereumRpcProvider(policy.chainId),
          (start, end) =>
            transactionsDiscoveryService.getAndSaveTransactionsForContract(
              contract,
              start,
              end
            )
        );
      }
    },
    { logger, entities: [Transaction, TransactionScanCheckpoint] }
  );
});
