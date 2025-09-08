import { persistTransactions } from '../db';
import { Transaction } from '../entities/ITransaction';
import { Logger } from '../logging';
import { doInDbContext } from '../secrets';
import * as sentryContext from '../sentry.context';
import { sqlExecutor } from '../sql-executor';
import { equalIgnoreCase } from '../strings';
import { findTransactionValues } from '../transaction_values';
import { withRetry } from './retry';
import { wrongTransactions } from './wrong-transactions';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await replay();
      // await fixLatest();
    },
    { logger, entities: [Transaction] }
  );
});

// async function findWrongTransactions() {
//   // logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);

//   const allTransactions: Transaction[] = await sqlExecutor.execute(
//     `SELECT * FROM transactions
//     WHERE from_address != '${NULL_ADDRESS}'
//     and from_address != '${MANIFOLD}'
//     and to_address != '${NULL_ADDRESS}'
//     and to_address != '${NULL_ADDRESS_DEAD}'
//     and value > 0
//     order by block desc;`
//   );

//   console.log('Found', allTransactions.length, 'transactions');

//   const chunkSize = 150;
//   const wrongTransactions: Transaction[] = [];
//   const txList = new Set<string>();

//   for (let i = 0; i < allTransactions.length; i += chunkSize) {
//     const chunkedTransactions = allTransactions.slice(i, i + chunkSize);

//     const chunk = chunkedTransactions.map((t) => structuredClone(t));
//     const transactionsWithValues = await withRetry(
//       () => findTransactionValues(chunk),
//       {
//         retries: 10,
//         minDelayMs: 1000,
//         maxDelayMs: 15000,
//         onRetry: (err, attempt) => {
//           logger.warn(
//             `findTransactionValues failed (attempt ${attempt}) — ${err.code || ''} ${err.status || ''} ${err.message || err}`
//           );
//         }
//       }
//     );

//     for (const t of transactionsWithValues) {
//       const originalTransaction = chunkedTransactions.find(
//         (t2) =>
//           equalIgnoreCase(t2.transaction, t.transaction) &&
//           equalIgnoreCase(t2.from_address, t.from_address) &&
//           equalIgnoreCase(t2.to_address, t.to_address) &&
//           equalIgnoreCase(t2.contract, t.contract) &&
//           equalIgnoreCase(t2.token_id.toString(), t.token_id.toString()) &&
//           t2.token_count === t.token_count
//       );

//       if (!originalTransaction) {
//         console.log('Missing transaction', t.transaction);
//       }
//       if (originalTransaction?.value !== t.value) {
//         console.log(
//           'Value mismatch',
//           t.transaction,
//           t.value,
//           originalTransaction?.value
//         );
//         wrongTransactions.push(t);
//         txList.add(t.transaction);
//       }
//       if (originalTransaction?.royalties !== t.royalties) {
//         console.log(
//           'Royalties mismatch',
//           t.transaction,
//           t.royalties,
//           originalTransaction?.royalties
//         );
//         wrongTransactions.push(t);
//         txList.add(t.transaction);
//       }
//     }

//     console.log(
//       'Processed chunk',
//       i / chunkSize + 1,
//       'of',
//       Math.ceil(allTransactions.length / chunkSize),
//       `[Wrong transactions: ${txList.size}]`
//     );

//     //sleep for 1 second
//     await new Promise((resolve) => setTimeout(resolve, 1000));
//   }

//   const outPath = path.join(process.cwd(), 'wrong-transactions.ts');

//   const contents =
//     `export const transactions = [\n` +
//     Array.from(txList)
//       .map((h) => `  '${h}'`)
//       .join(',\n') +
//     `\n];`;

//   await fs.writeFile(outPath, contents, 'utf8');

//   console.log(
//     'Found Wrong transactions',
//     wrongTransactions.length,
//     `[Unique: ${txList.size}]`
//   );

//   process.exit(0);
// }

async function replay() {
  // logger.info(`[CUSTOM REPLAY NOT IMPLEMENTED]`);

  console.log('Wrong Transactions count', wrongTransactions.length);
  const chunkSize = 50;

  let transactionEntriesLength = 0;

  for (let i = 0; i < wrongTransactions.length; i += chunkSize) {
    const chunkedTransactions = wrongTransactions.slice(i, i + chunkSize);
    const chunkIndex = i / chunkSize + 1;

    const transactions = await sqlExecutor.execute(
      `SELECT * FROM transactions WHERE transaction IN (${chunkedTransactions.map((t) => `'${t}'`).join(',')})`
    );

    console.log(
      `[Chunk ${chunkIndex}]`,
      'Found',
      transactions.length,
      'transactions'
    );

    transactionEntriesLength += transactions.length;

    const chunk = transactions.map((t) => structuredClone(t));

    const transactionsWithValues = await withRetry(
      () => findTransactionValues(chunk),
      {
        retries: 10,
        minDelayMs: 1000,
        maxDelayMs: 15000,
        onRetry: (err, attempt) => {
          logger.warn(
            `findTransactionValues failed (attempt ${attempt}) — ${err.code || ''} ${err.status || ''} ${err.message || err}`
          );
        }
      }
    );

    for (const t of transactionsWithValues) {
      const originalTransaction = transactions.find(
        (t2) =>
          equalIgnoreCase(t2.transaction, t.transaction) &&
          equalIgnoreCase(t2.from_address, t.from_address) &&
          equalIgnoreCase(t2.to_address, t.to_address) &&
          equalIgnoreCase(t2.contract, t.contract) &&
          equalIgnoreCase(t2.token_id.toString(), t.token_id.toString()) &&
          t2.token_count === t.token_count
      );

      if (!originalTransaction) {
        console.log('Missing transaction', t.transaction);
      }
      if (originalTransaction?.value !== t.value) {
        console.log(
          'Value mismatch',
          t.transaction,
          t.token_id,
          'new',
          t.value,
          'old',
          originalTransaction?.value
        );
      }
      if (originalTransaction?.royalties !== t.royalties) {
        console.log(
          'Royalties mismatch',
          t.transaction,
          t.token_id,
          'new',
          t.royalties,
          'old',
          originalTransaction?.royalties
        );
      }
    }

    await persistTransactions(transactionsWithValues);

    console.log(
      'Processed chunk',
      chunkIndex,
      'of',
      Math.ceil(wrongTransactions.length / chunkSize),
      `[Transaction entries: ${transactionEntriesLength}]`
    );

    //sleep for 2 seconds
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log(
    'All transactions processed',
    `[Total transaction entries: ${transactionEntriesLength}]`
  );

  process.exit(0);
}

// async function fixLatest() {
//   const latestTransactions = await sqlExecutor.execute(
//     `SELECT * FROM transactions WHERE block >= 23281960`
//   );

//   console.log('Wrong Transactions count', latestTransactions.length);
//   const chunkSize = 100;

//   let transactionEntriesLength = 0;

//   for (let i = 0; i < latestTransactions.length; i += chunkSize) {
//     const chunkedTransactions = latestTransactions.slice(i, i + chunkSize);
//     const chunkIndex = i / chunkSize + 1;

//     console.log(
//       `[Chunk ${chunkIndex}]`,
//       'Found',
//       chunkedTransactions.length,
//       'transactions'
//     );

//     transactionEntriesLength += chunkedTransactions.length;

//     const chunk = chunkedTransactions.map((t) => structuredClone(t));

//     const transactionsWithValues = await withRetry(
//       () => findTransactionValues(chunk),
//       {
//         retries: 10,
//         minDelayMs: 1000,
//         maxDelayMs: 15000,
//         onRetry: (err, attempt) => {
//           logger.warn(
//             `findTransactionValues failed (attempt ${attempt}) — ${err.code || ''} ${err.status || ''} ${err.message || err}`
//           );
//         }
//       }
//     );

//     for (const t of transactionsWithValues) {
//       const originalTransaction = chunkedTransactions.find(
//         (t2) =>
//           equalIgnoreCase(t2.transaction, t.transaction) &&
//           equalIgnoreCase(t2.from_address, t.from_address) &&
//           equalIgnoreCase(t2.to_address, t.to_address) &&
//           equalIgnoreCase(t2.contract, t.contract) &&
//           equalIgnoreCase(t2.token_id.toString(), t.token_id.toString()) &&
//           t2.token_count === t.token_count
//       );

//       if (!originalTransaction) {
//         console.log('Missing transaction', t.transaction);
//       }
//       if (originalTransaction?.value !== t.value) {
//         console.log(
//           'Value mismatch',
//           t.transaction,
//           t.token_id,
//           'new',
//           t.value,
//           'old',
//           originalTransaction?.value
//         );
//       }
//       if (originalTransaction?.royalties !== t.royalties) {
//         console.log(
//           'Royalties mismatch',
//           t.transaction,
//           t.token_id,
//           'new',
//           t.royalties,
//           'old',
//           originalTransaction?.royalties
//         );
//       }
//     }

//     await persistTransactions(transactionsWithValues);

//     console.log(
//       'Processed chunk',
//       chunkIndex,
//       'of',
//       Math.ceil(latestTransactions.length / chunkSize),
//       `[Transaction entries: ${transactionEntriesLength}]`
//     );

//     //sleep for 2 seconds
//     await new Promise((resolve) => setTimeout(resolve, 2000));
//   }

//   console.log(
//     'All transactions processed',
//     `[Total transaction entries: ${transactionEntriesLength}]`
//   );

//   process.exit(0);
// }
