import { Alchemy, fromHex, toHex, Utils } from 'alchemy-sdk';
import {
  ALCHEMY_SETTINGS,
  OPENSEA_ADDRESS,
  ROYALTIES_ADDRESS
} from './constants';
import { Transaction } from './entities/ITransaction';
import { areEqualAddresses } from './helpers';
import { ethers } from 'ethers';

let SEAPORT_IFACE: any = undefined;
const fetch = require('node-fetch');

async function loadSeaport() {
  const f = await fetch(
    `https://api.etherscan.io/api?module=contract&action=getabi&address=${OPENSEA_ADDRESS}&apikey=${process.env.ETHERSCAN_API_KEY}`
  );
  const abi = await f.json();
  SEAPORT_IFACE = new ethers.utils.Interface(abi.result);
  console.log('[ROYALTIES]', `[SEAPORT LOADED ${f.status}]`);
}

let alchemy: Alchemy;

export const findTransactionValues = async (transactions: Transaction[]) => {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  if (!SEAPORT_IFACE) {
    await loadSeaport();
  }

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
      if (!t.value || t.value != value) {
        t.value = value;
        t.transaction_date = new Date(t.transaction_date);
        transactionsWithValues.push(t);
      }
    })
  );

  console.log(
    new Date(),
    '[TRANSACTION VALUES]',
    `[PROCESSED ${transactionsWithValues.length} TRANSACTION VALUES]`
  );

  return transactionsWithValues;
};

async function resolveValue(t: Transaction, receipt: any, events: number) {
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
    const seaResult = SEAPORT_IFACE.parseTransaction({
      data: receipt.data,
      value: receipt.value
    });
    let newValue = 0;
    seaResult.args[0].map((r: any) => {
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

  if (receipt?.data.includes('0xfb0f3ee1')) {
    const seaResult = SEAPORT_IFACE.parseTransaction({
      data: receipt.data
    });
    seaResult.args.map((a: any) => {
      const tokenid = a[1].toString();
      const count = a[2].toString();
      const amount = parseFloat(Utils.formatEther(a[7].toString()));
      const tokenPrice = amount / count;
      if (t.token_id == tokenid) {
        value = Math.round(tokenPrice * t.token_count * 10000) / 10000;
      }
    });
  }

  return value;
}

export const runValues = async () => {
  console.log('hello values');
  if (!alchemy) {
    alchemy = new Alchemy({
      ...ALCHEMY_SETTINGS,
      apiKey: process.env.ALCHEMY_API_KEY
    });
  }

  if (!SEAPORT_IFACE) {
    await loadSeaport();
  }

  const receipt = await alchemy.core.getTransaction(
    // '0x97df4644aff593e8ff0b26dfa1f73ca191969278bbb27d30f774dded76c22115'
    // '0xb1a74e8908ec700918e95f090c7678df08cfbd72eea8dd19576b047211bd275a',
    // '0x935d546c77d0d76b06c4c5abb0108de14d7a15d92977cb2e9c7e581ac0e3a907'
    // '0x97a3fd74fa1efaebd0f1114964f5c0d7f931eee3642ec3588933511b6ce6ee2a'
    '0xc11ced3274e6f6adbaf42ff81f931aa75f186b01975bfa63c5cd7c5f141392c4'
  );
  // console.log(receipt);
  // const royaltyPayment = receipt?.logs?.filter((l) =>
  //   l.data.includes(ROYALTIES_ADDRESS.slice(2))
  // );
  // console.log();
  // console.log(royaltyPayment?.length);

  if (receipt?.data) {
    try {
      // const seaResult = SEAPORT_IFACE.parseTransaction({
      //   data: receipt.data
      // });
      // const args = seaResult.args[0];
      // const offer = args.parameters.offer[0];
      // const contract = offer.token;
      // const tokenId = fromHex(offer.identifierOrCriteria);
      // console.log(contract, tokenId, royaltyValue);
    } catch (err: any) {
      console.log(err);
    }
  }
};
