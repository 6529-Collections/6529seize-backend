import { Interface, zeroPadValue } from 'ethers';
import { Alchemy, AssetTransfersCategory, SortingOrder } from '@/alchemy-sdk';
import {
  ALCHEMY_SETTINGS,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT
} from '@/constants';
import { getEthereumRpcClient } from '@/ethereum-rpc/ethereum-rpc-client';
import { Log } from '@/ethereum-rpc/ethereum-rpc-types';
import { CLAIM_EXTENSIONS } from './claim-events';

export const HISTORY_CREATORS = [MEMES_CONTRACT, MEMELAB_CONTRACT];
export const HISTORY_SOURCE_IFACE = new Interface([
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
  'event URI(string value,uint256 indexed id)',
  'event ClaimInitialized(address indexed creatorContract,uint256 indexed instanceId,address initializer)',
  'event ClaimUpdated(address indexed creatorContract,uint256 indexed instanceId)',
  // Older claim generations did not include the initializer in this event.
  'event ClaimInitialized(address indexed creatorContract,uint256 indexed instanceId)'
]);

export interface HistoryTransaction {
  hash: string;
  block: number;
  transactionIndex: number;
  logs: Log[];
}

/** Event discovery is creator-scoped. No wallet is an inclusion/exclusion rule. */
export async function discoverHistoryTransactions(
  fromBlock: number,
  toBlock: number,
  audit = false
): Promise<HistoryTransaction[]> {
  const rpc = getEthereumRpcClient();
  const bounds = {
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${toBlock.toString(16)}`
  };
  const topic = (name: string) =>
    HISTORY_SOURCE_IFACE.getEvent(name)!.topicHash;
  const groups = await Promise.all([
    rpc.getLogs({
      ...bounds,
      address: HISTORY_CREATORS,
      topics: [
        [topic('TransferSingle'), topic('TransferBatch')],
        null,
        zeroPadValue('0x00', 32)
      ]
    }),
    rpc.getLogs({
      ...bounds,
      address: HISTORY_CREATORS,
      topics: [topic('URI')]
    }),
    rpc.getLogs({
      ...bounds,
      ...(audit ? {} : { address: CLAIM_EXTENSIONS }),
      topics: [
        [
          topic('ClaimUpdated'),
          topic('ClaimInitialized(address,uint256,address)'),
          topic('ClaimInitialized(address,uint256)')
        ],
        HISTORY_CREATORS.map((address) => zeroPadValue(address, 32))
      ]
    })
  ]);
  const transactions = collectHistoryLogs(groups.flat(), fromBlock, toBlock);

  // Manifold's direct setTokenURI emits no URI event. Query calls TO the two
  // creator contracts: top-level external calls, including zero-value calls,
  // rather than calls FROM an admin. Internal forwarded calls need traces.
  const alchemy = new Alchemy({
    ...ALCHEMY_SETTINGS,
    apiKey: process.env.ALCHEMY_API_KEY
  });
  for (const contract of HISTORY_CREATORS) {
    await collectDirectCreatorCalls(
      alchemy,
      contract,
      bounds,
      transactions,
      fromBlock,
      toBlock
    );
  }
  for (const entry of Array.from(transactions.values()))
    entry.logs.sort((a, b) => a.logIndex - b.logIndex);
  return Array.from(transactions.values()).sort(
    (a, b) => a.block - b.block || a.transactionIndex - b.transactionIndex
  );
}

function collectHistoryLogs(
  logs: Log[],
  fromBlock: number,
  toBlock: number
): Map<string, HistoryTransaction> {
  const transactions = new Map<string, HistoryTransaction>();
  for (const log of logs) {
    if (log.removed || log.blockNumber < fromBlock || log.blockNumber > toBlock)
      throw new Error('Noncanonical or out-of-range history source log');
    const key = log.transactionHash.toLowerCase();
    const entry = transactions.get(key) ?? {
      hash: log.transactionHash,
      block: log.blockNumber,
      transactionIndex: log.transactionIndex,
      logs: []
    };
    if (!entry.logs.some((existing) => existing.logIndex === log.logIndex))
      entry.logs.push(log);
    transactions.set(key, entry);
  }

  return transactions;
}

async function directCreatorTransaction(
  hash: string,
  contract: string,
  fromBlock: number,
  toBlock: number
): Promise<HistoryTransaction> {
  const tx = await getEthereumRpcClient().getTransaction(hash);
  if (!tx || tx.blockNumber === null)
    throw new Error(`History transaction unavailable: ${hash}`);
  if (tx.to?.toLowerCase() !== contract.toLowerCase())
    throw new Error('Creator transaction discovery returned another target');
  if (tx.blockNumber < fromBlock || tx.blockNumber > toBlock)
    throw new Error('Creator transaction discovery returned another range');
  return {
    hash: tx.hash,
    block: tx.blockNumber,
    transactionIndex: tx.index,
    logs: []
  };
}

async function collectDirectCreatorCalls(
  alchemy: Alchemy,
  contract: string,
  bounds: { fromBlock: string; toBlock: string },
  transactions: Map<string, HistoryTransaction>,
  fromBlock: number,
  toBlock: number
): Promise<void> {
  let pageKey: string | undefined;
  const seenPages = new Set<string>();
  do {
    const page = await alchemy.core.getAssetTransfers({
      ...bounds,
      toAddress: contract,
      category: [AssetTransfersCategory.EXTERNAL],
      excludeZeroValue: false,
      withMetadata: true,
      maxCount: 150,
      order: SortingOrder.ASCENDING,
      ...(pageKey ? { pageKey } : {})
    });
    for (const transfer of page.transfers) {
      const key = transfer.hash.toLowerCase();
      if (transactions.has(key)) continue;
      transactions.set(
        key,
        await directCreatorTransaction(
          transfer.hash,
          contract,
          fromBlock,
          toBlock
        )
      );
    }
    pageKey = page.pageKey;
    if (pageKey && seenPages.has(pageKey))
      throw new Error('History discovery returned a repeated page cursor');
    if (pageKey) seenPages.add(pageKey);
  } while (pageKey);
}
