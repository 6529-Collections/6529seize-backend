import { Alchemy, fromHex, Utils } from 'alchemy-sdk';
import {
  ALCHEMY_SETTINGS,
  MEMELAB_CONTRACT,
  MEMELAB_ROYALTIES_ADDRESS,
  MEMES_CONTRACT,
  OPENSEA_ADDRESS,
  ROYALTIES_ADDRESS
} from './constants';
import { Transaction } from './entities/ITransaction';
import { areEqualAddresses } from './helpers';
import { ethers } from 'ethers';

let SEAPORT_IFACE: any = undefined;

const fetch = require('node-fetch');

async function loadABIs() {
  const f = await fetch(
    `https://api.etherscan.io/api?module=contract&action=getabi&address=${OPENSEA_ADDRESS}&apikey=${process.env.ETHERSCAN_API_KEY}`
  );
  const abi = await f.json();
  SEAPORT_IFACE = new ethers.utils.Interface(abi.result);

  console.log('[ROYALTIES]', `[ABIs LOADED]`, `[SEAPORT ${f.status}]`);
}

let alchemy: Alchemy;

export const findTransactionValues = async (transactions: Transaction[]) => {
  alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  if (!SEAPORT_IFACE) {
    await loadABIs();
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
      const parsedTransaction = await resolveValue(t, receipt, transferEvents);
      transactionsWithValues.push(parsedTransaction);
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
  t.value = receipt ? parseFloat(Utils.formatEther(receipt.value)) / events : 0;

  const transaction = await alchemy.core.getTransaction(t.transaction);

  let royaltiesAddress = ROYALTIES_ADDRESS;
  let tokenContract = t.contract;
  if (areEqualAddresses(t.contract, MEMELAB_CONTRACT)) {
    royaltiesAddress = MEMELAB_ROYALTIES_ADDRESS;
    tokenContract = MEMELAB_CONTRACT;
  }

  if (transaction) {
    const receipt = await alchemy.core.getTransactionReceipt(transaction?.hash);
    if (receipt?.gasUsed) {
      const gasUnits = receipt.gasUsed.toNumber();
      const gasPrice = parseFloat(Utils.formatEther(receipt.effectiveGasPrice));
      const gasPriceGwei =
        Math.round(gasPrice * 1000000000 * 100000000) / 100000000;
      const gas = Math.round(gasUnits * gasPrice * 100000000) / 100000000;

      t.gas_gwei = gasUnits;
      t.gas_price = gasPrice;
      t.gas_price_gwei = gasPriceGwei;
      t.gas = gas;
    }

    receipt?.logs.map(async (log) => {
      const parsedLog = await parseSeaportLog(
        tokenContract,
        royaltiesAddress,
        log
      );

      if (
        parsedLog &&
        parsedLog.tokenId == t.token_id &&
        areEqualAddresses(parsedLog.contract, t.contract)
      ) {
        t.royalties = parsedLog.amount;
        t.value = parsedLog.totalAmount ? parsedLog.totalAmount : t.value;
      }
    });
  }

  return t;
}

export const runValues = async () => {
  if (!alchemy) {
    alchemy = new Alchemy({
      ...ALCHEMY_SETTINGS,
      apiKey: process.env.ALCHEMY_API_KEY
    });
  }

  if (!SEAPORT_IFACE) {
    await loadABIs();
  }

  const transactions = [
    // '0x5df5b55e068191871c3bea2230d2a1b6fd22e4a22e5aa365b862fe2d6ce38c86'
    // '0x7ddf171720509499fce0bec78bb0b3c60ab61df277f9e87cad5025b4cbc93049'
    '0x65826174b35183b4ed557c1aeb036cc8baddfe89b04ae86cdf15ad7979fc7fe7'
  ];

  await Promise.all(
    transactions.map(async (transactionHash) => {
      const transaction = await alchemy.core.getTransaction(transactionHash);

      if (transaction) {
        const receipt = await alchemy.core.getTransactionReceipt(
          transaction?.hash
        );
        let royaltiesAddress = ROYALTIES_ADDRESS;
        let tokenContract = MEMES_CONTRACT;
        if (receipt?.contractAddress) {
          tokenContract = receipt?.contractAddress;
          if (areEqualAddresses(receipt.contractAddress, MEMELAB_CONTRACT)) {
            royaltiesAddress = MEMELAB_ROYALTIES_ADDRESS;
          }
        }
        if (receipt?.gasUsed) {
          const gasUnits = receipt.gasUsed.toNumber();
          const gasPrice = parseFloat(
            Utils.formatEther(receipt.effectiveGasPrice)
          );
          const garPriceGwei =
            Math.round(gasPrice * 1000000000 * 100000000) / 100000000;
          const gas = Math.round(gasUnits * gasPrice * 100000000) / 100000000;
          console.log(gasUnits, gasPrice, garPriceGwei, gas);
        }

        receipt?.logs.map(async (log) => {
          const a = await parseSeaportLog(tokenContract, royaltiesAddress, log);
          if (a) console.log(a);
        });
      }
    })
  );
};

const parseSeaportLog = async (
  tokenContract: string,
  royaltiesAddress: string,
  log: ethers.providers.Log
) => {
  try {
    const seaResult = SEAPORT_IFACE.parseLog(log);

    const royaltiesConsideration = seaResult.args.consideration.find((c: any) =>
      areEqualAddresses(c.recipient, royaltiesAddress)
    );
    let tokenConsideration = seaResult.args.consideration.find((o: any) =>
      areEqualAddresses(o.token, tokenContract)
    );
    if (!tokenConsideration) {
      tokenConsideration = seaResult.args.offer.find((o: any) =>
        areEqualAddresses(o.token, tokenContract)
      );
    }
    if (royaltiesConsideration && tokenConsideration) {
      const contract = tokenConsideration.token;
      const tokenId = fromHex(tokenConsideration.identifier);
      const amount = parseFloat(
        Utils.formatEther(royaltiesConsideration.amount)
      );
      let totalAmount = 0;

      seaResult.args.offer
        .filter((o: any) => !areEqualAddresses(o.token, contract))
        .map((o: any) => {
          totalAmount += parseFloat(Utils.formatEther(o.amount));
        });

      seaResult.args.consideration
        .filter((o: any) => !areEqualAddresses(o.token, contract))
        .filter((o: any) => !areEqualAddresses(o.recipient, royaltiesAddress))
        .map((o: any) => {
          totalAmount += parseFloat(Utils.formatEther(o.amount));
        });

      return {
        contract,
        tokenId,
        amount,
        totalAmount
      };
    }
  } catch (err: any) {
    // console.log('sea error', log.address, err);
    return null;
  }
};
