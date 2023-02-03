import { fetchLatestTransactionsBlockNumber, persistTransactions } from '../db';
import { findTransactions } from '../transactions';
import { findTransactionValues } from '../transaction_values';
import { discoverEns } from '../ens';
import { loadEnv } from '../secrets';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING TRANSACTIONS LOOP]');
  await loadEnv();
  await transactionsLoop();
  console.log(new Date(), '[TRANSACTIONS LOOP COMPLETE]');
};

export async function transactionsLoop() {
  const now = new Date();
  await transactions();
  await discoverEns(now);
}

async function transactions(
  startingBlock?: number,
  latestBlock?: number,
  pagKey?: string
) {
  try {
    let startingBlockResolved;
    if (startingBlock == undefined) {
      startingBlockResolved = await fetchLatestTransactionsBlockNumber();
    } else {
      startingBlockResolved = startingBlock;
    }

    const response = await findTransactions(
      startingBlockResolved,
      latestBlock,
      pagKey
    );

    const transactionsWithValues = await findTransactionValues(
      response.transactions
    );

    await persistTransactions(transactionsWithValues);

    if (response.pageKey) {
      await transactions(
        startingBlockResolved,
        response.latestBlock,
        response.pageKey
      );
    }
  } catch (e: any) {
    console.log(
      new Date(),
      '[TRANSACTIONS]',
      '[ETIMEDOUT!]',
      e,
      '[RETRYING PROCESS]'
    );
    await transactions(startingBlock, latestBlock, pagKey);
  }
}
