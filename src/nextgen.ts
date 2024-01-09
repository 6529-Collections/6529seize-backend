import { ethers } from 'ethers';
import {
  Alchemy,
  AssetTransfersCategory,
  AssetTransfersWithMetadataParams,
  SortingOrder
} from 'alchemy-sdk';
import {
  ALCHEMY_SETTINGS,
  NEXTGEN_CONTRACT,
  NEXTGEN_NETWORK
} from './constants';
import { Logger } from './logging';
import { NEXTGEN_CORE_IFACE } from './abis/nextgen';

const logger = Logger.get('NEXTGEN_TRANSACTIONS');

let alchemy: Alchemy;

export async function findCoreTransactions() {
  alchemy = new Alchemy({
    network: NEXTGEN_NETWORK,
    maxRetries: 10,
    apiKey: process.env.ALCHEMY_API_KEY
  });

  await findTransactions();
}

async function findTransactions() {
  logger.info(`[FINDING TRANSACTIONS]`);
  const settings: AssetTransfersWithMetadataParams = {
    category: [AssetTransfersCategory.EXTERNAL],
    excludeZeroValue: false,
    maxCount: 1,
    fromBlock: '0x0',
    toBlock: 'latest',
    pageKey: undefined,
    toAddress: NEXTGEN_CONTRACT[NEXTGEN_NETWORK],
    withMetadata: true,
    order: SortingOrder.ASCENDING
  };
  console.log('i am pre-response');
  const response = await alchemy.core.getAssetTransfers(settings);
  console.log('i am response', response.transfers.length);
  const logs: string[] = [];
  for (const transfer of response.transfers) {
    const receipt = await alchemy.core.getTransaction(transfer.hash);
    if (receipt) {
      const parsedReceipt = NEXTGEN_CORE_IFACE.parseTransaction({
        data: receipt.data,
        value: 0
      });
      const methodName = parsedReceipt.name;
      const args = parsedReceipt.args;
      logs.push(`${methodName} :: ${args.join(', ')}`);
      console.log('parsed', transfer.hash);
    }
  }

  console.log('i am logs', logs);
  return response;
}

async function parseReceiptData(data: string) {
  const a = NEXTGEN_CORE_IFACE.parseTransaction({ data, value: 0 });
}
