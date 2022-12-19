import { Alchemy, fromHex, toHex, Utils } from 'alchemy-sdk';
import web3 from 'web3';
import { ALCHEMY_SETTINGS } from './constants';
import { Transaction } from './entities/ITransaction';

const alchemy = new Alchemy(ALCHEMY_SETTINGS);

export const findTransactionValues = async (transactions: Transaction[]) => {
  console.log(
    new Date(),
    '[TRANSACTION VALUES]',
    `[PROCESSING VALUES FOR ${transactions.length} TRANSACTIONS]`
  );

  const transactionsWithValues: Transaction[] = [];

  await Promise.all(
    transactions.map(async (t) => {
      const transferEvents = [...transactions].filter(
        (t1) => t.transaction == t1.transaction
      ).length;

      const receipt = await alchemy.core.getTransaction(t.transaction);
      let value = receipt
        ? parseFloat(Utils.formatEther(receipt.value)) / transferEvents
        : 0;
      try {
        if (!value && receipt?.data.includes('0xab834bab')) {
          const result =
            receipt?.data.replace('0xab834bab', '').match(/.{1,64}/g) ?? [];
          const bidValue = parseFloat(
            Utils.formatEther(parseInt(result[18], 16).toString())
          );
          if (bidValue > value) {
            value = bidValue;
          }
        }
      } catch (e: any) {
        console.log(
          new Date(),
          '[TRANSACTION VALUES]',
          `[EXCEPTION FOR TRANSACTION HASH ${t.transaction}]`,
          e
        );
      }
      t.value = value;
      t.transaction_date = new Date(t.transaction_date);
      transactionsWithValues.push(t);
    })
  );

  console.log(
    new Date(),
    '[TRANSACTION VALUES]',
    `[PROCESSED ${transactionsWithValues.length} TRANSACTION VALUES]`
  );

  return transactionsWithValues;
};
