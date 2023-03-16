import {
  fetchLatestTransactionsBlockNumber,
  persistDistributionMinting,
  persistTransactions
} from '../db';
import { findTransactions } from '../transactions';
import { findTransactionValues, runValues } from '../transaction_values';
import { discoverEns } from '../ens';
import { loadEnv, unload } from '../secrets';
import { areEqualAddresses } from '../helpers';
import { MANIFOLD } from '../constants';

export const handler = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING TRANSACTIONS LOOP]');
  await loadEnv();
  await transactionsLoop();
  await unload();
  console.log(new Date(), '[TRANSACTIONS LOOP COMPLETE]');
};

export const handlerValues = async (event?: any, context?: any) => {
  console.log(new Date(), '[RUNNING TRANSACTIONS VALUES]');
  await loadEnv();
  await runValues();
  console.log(new Date(), '[TRANSACTIONS VALUES COMPLETE]');
};

export async function transactionsLoop() {
  const now = new Date();
  await transactions();
  await discoverEns(now);
}

export async function transactions(
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

    const manifoldTransactions = transactionsWithValues.filter((tr) =>
      areEqualAddresses(tr.from_address, MANIFOLD)
    );

    await persistDistributionMinting(manifoldTransactions);

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
