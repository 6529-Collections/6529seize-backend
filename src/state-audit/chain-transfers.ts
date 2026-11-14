import type { Log } from '@/ethereum-rpc/ethereum-rpc-types';
import {
  extractNftTransferEdgesFromLog,
  getNftTransferKey,
  NFT_TRANSFER_TOPICS
} from '@/nft-transfer-edges';
import type { StateAuditRpc } from './block-anchors';
import type {
  InconclusiveReason,
  InspectedChunk,
  InspectedTransaction
} from './state-audit.manifest';

/** Blocks per eth_getLogs request; small enough for every common provider. */
export const LOG_CHUNK_BLOCKS = 500;
/**
 * Providers that cap a getLogs response (Alchemy, Infura, QuickNode) do so at
 * 10,000 logs. A chunk that reaches the cap may have been truncated silently.
 */
export const MAX_LOGS_PER_CHUNK = 10_000;

export const TRANSFER_TOPIC_FILTER: string[] = [
  NFT_TRANSFER_TOPICS.ERC721_TRANSFER,
  NFT_TRANSFER_TOPICS.ERC1155_TRANSFER_SINGLE,
  NFT_TRANSFER_TOPICS.ERC1155_TRANSFER_BATCH
];

/** One ledger-shaped ownership edge summed over all logs of a transaction. */
export interface ChainTransfer {
  transaction: string;
  block: number;
  block_hash: string;
  transaction_index: number;
  from_address: string;
  to_address: string;
  contract: string;
  token_id: string;
  amount: bigint;
  log_indexes: number[];
}

export interface ChainTransferResult {
  transfers: ChainTransfer[];
  inspected: InspectedTransaction[];
  chunks: InspectedChunk[];
  log_count: number;
  problems: InconclusiveReason[];
}

export function toHexBlock(block: number): string {
  return `0x${block.toString(16)}`;
}

export function blockChunks(
  fromBlock: number,
  toBlock: number,
  chunkSize: number = LOG_CHUNK_BLOCKS
): { from_block: number; to_block: number }[] {
  const chunks: { from_block: number; to_block: number }[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    chunks.push({
      from_block: start,
      to_block: Math.min(start + chunkSize - 1, toBlock)
    });
  }
  return chunks;
}

function compareTransfers(a: ChainTransfer, b: ChainTransfer): number {
  return (
    a.block - b.block ||
    a.transaction_index - b.transaction_index ||
    a.transaction.localeCompare(b.transaction) ||
    a.from_address.localeCompare(b.from_address) ||
    a.to_address.localeCompare(b.to_address) ||
    compareTokenIds(a.token_id, b.token_id)
  );
}

export function compareTokenIds(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareNumbers(a: number, b: number): number {
  return a - b;
}

/**
 * Sums the ownership edges of a set of logs per transaction and
 * from:to:contract:tokenId, exactly as the ingest path merges repeated edges.
 * Removed (reorged-out) logs are skipped. Logs with a transfer topic that do
 * not decode are reported as problems instead of silently dropped.
 */
export function summarizeTransferLogs(
  logs: readonly Log[],
  contract: string
): {
  transfers: ChainTransfer[];
  inspected: InspectedTransaction[];
  problems: InconclusiveReason[];
} {
  const contractLower = contract.toLowerCase();
  const byKey = new Map<string, ChainTransfer>();
  const inspectedByTx = new Map<string, InspectedTransaction>();
  const problems: InconclusiveReason[] = [];

  for (const log of logs) {
    if (log.removed) continue;
    if (log.address.toLowerCase() !== contractLower) {
      problems.push({
        code: 'foreign_log',
        detail: `log ${log.transactionHash}#${log.logIndex} belongs to ${log.address}`
      });
      continue;
    }
    const edges = extractNftTransferEdgesFromLog(log);
    if (!edges.length) {
      problems.push({
        code: 'unparsed_log',
        detail: `log ${log.transactionHash}#${log.logIndex} has a transfer topic but did not decode`
      });
      continue;
    }
    recordInspected(inspectedByTx, log);
    const transaction = log.transactionHash.toLowerCase();
    for (const edge of edges) {
      const key = `${transaction}|${getNftTransferKey(edge.from, edge.to, edge.contract, edge.tokenId)}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.amount += edge.amount;
        if (!existing.log_indexes.includes(log.logIndex))
          existing.log_indexes.push(log.logIndex);
        continue;
      }
      byKey.set(key, {
        transaction,
        block: log.blockNumber,
        block_hash: log.blockHash,
        transaction_index: log.transactionIndex,
        from_address: edge.from.toLowerCase(),
        to_address: edge.to.toLowerCase(),
        contract: contractLower,
        token_id: edge.tokenId,
        amount: edge.amount,
        log_indexes: [log.logIndex]
      });
    }
  }

  const transfers = Array.from(byKey.values())
    .map((transfer) => ({
      ...transfer,
      log_indexes: transfer.log_indexes.slice().sort(compareNumbers)
    }))
    .sort(compareTransfers);
  const inspected = Array.from(inspectedByTx.values())
    .map((tx) => ({
      ...tx,
      log_indexes: tx.log_indexes.slice().sort(compareNumbers)
    }))
    .sort(
      (a, b) =>
        a.block - b.block ||
        a.transaction_index - b.transaction_index ||
        a.transaction.localeCompare(b.transaction)
    );
  return { transfers, inspected, problems };
}

function recordInspected(
  inspectedByTx: Map<string, InspectedTransaction>,
  log: Log
): void {
  const transaction = log.transactionHash.toLowerCase();
  const existing = inspectedByTx.get(transaction);
  if (existing) {
    if (!existing.log_indexes.includes(log.logIndex))
      existing.log_indexes.push(log.logIndex);
    return;
  }
  inspectedByTx.set(transaction, {
    transaction,
    block: log.blockNumber,
    block_hash: log.blockHash,
    transaction_index: log.transactionIndex,
    log_indexes: [log.logIndex]
  });
}

/**
 * Fetches every transfer log of `contract` in the inclusive window from the
 * RPC in bounded chunks. RPC errors propagate to the caller, which must then
 * report the audit as inconclusive.
 */
export async function fetchChainTransfers(
  rpc: StateAuditRpc,
  contract: string,
  fromBlock: number,
  toBlock: number
): Promise<ChainTransferResult> {
  const logs: Log[] = [];
  const chunks: InspectedChunk[] = [];
  const problems: InconclusiveReason[] = [];
  for (const chunk of blockChunks(fromBlock, toBlock)) {
    const chunkLogs = await rpc.getLogs({
      // NOSONAR -- chunks run sequentially to respect provider rate limits.
      address: contract,
      fromBlock: toHexBlock(chunk.from_block),
      toBlock: toHexBlock(chunk.to_block),
      topics: [TRANSFER_TOPIC_FILTER]
    });
    chunks.push({ ...chunk, log_count: chunkLogs.length });
    if (chunkLogs.length >= MAX_LOGS_PER_CHUNK) {
      problems.push({
        code: 'log_response_capped',
        detail: `chunk ${chunk.from_block}-${chunk.to_block} returned ${chunkLogs.length} logs; the provider may have truncated it`
      });
    }
    const outOfRange = chunkLogs.filter(
      (log) =>
        log.blockNumber < chunk.from_block || log.blockNumber > chunk.to_block
    );
    if (outOfRange.length) {
      problems.push({
        code: 'foreign_log',
        detail: `chunk ${chunk.from_block}-${chunk.to_block} returned ${outOfRange.length} logs outside its range`
      });
    }
    chunkLogs.forEach((log) => logs.push(log));
  }
  const summary = summarizeTransferLogs(logs, contract);
  return {
    transfers: summary.transfers,
    inspected: summary.inspected,
    chunks,
    log_count: logs.length,
    problems: problems.concat(summary.problems)
  };
}
