import { Alchemy, fromHex, toHex, Utils } from 'alchemy-sdk';
import { ALCHEMY_SETTINGS } from './constants';
import { Transaction } from './entities/ITransaction';
import { areEqualAddresses } from './helpers';
import { ethers } from 'ethers';
// import { SEAPORT_ABI } from './abis/seaportabi';

const SEAPORT_ABI = require('./abis/seaportabi');
const SEAPORT_IFACE = new ethers.utils.Interface(SEAPORT_ABI);
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
      const value = await resolveValue(t, receipt, transferEvents);
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

export async function resolveValue(
  t: Transaction,
  receipt: any,
  events: number
) {
  let value = receipt
    ? parseFloat(Utils.formatEther(receipt.value)) / events
    : 0;
  if (receipt?.data.includes('0xab834bab')) {
    try {
      const result =
        receipt?.data.replace('0xab834bab', '').match(/.{1,64}/g) ?? [];
      const bidValue = parseFloat(
        Utils.formatEther(parseInt(result[18], 16).toString())
      );
      if (bidValue > value) {
        value = bidValue;
      }
    } catch (e: any) {
      console.log(
        new Date(),
        '[TRANSACTION VALUES]',
        `[EXCEPTION FOR TRANSACTION HASH ${t.transaction}]`,
        e
      );
    }
  }
  if (receipt?.data.includes('0xed98a574')) {
    const result = SEAPORT_IFACE.parseTransaction({
      data: receipt.data,
      value: receipt.value
    });
    let newValue = 0;
    result.args[0].map((r: any) => {
      const from = r[0][0];
      const token_id = r[0][2][0][2].toString();

      if (token_id == t.token_id && areEqualAddresses(from, t.from_address)) {
        r[0][3].map((a: any[]) => {
          newValue += parseFloat(Utils.formatEther(a[3].toString()));
        });
      }
    });

    if (newValue) {
      value = Math.round(newValue * 10000) / 10000;
    }
  }

  return value;
}

export const runValues = async () => {
  const receipt = await alchemy.core.getTransaction(
    '0x97df4644aff593e8ff0b26dfa1f73ca191969278bbb27d30f774dded76c22115'
    // '0xb1a74e8908ec700918e95f090c7678df08cfbd72eea8dd19576b047211bd275a'
  );

  console.log(receipt);
};
