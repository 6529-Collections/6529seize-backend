import { ethers } from 'ethers';
import type { Log } from '@/ethereum-rpc/ethereum-rpc-types';

const IFACE = new ethers.Interface([
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)',
  'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
  'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)'
]);

export const FIXTURE_OPERATOR = '0x9999999999999999999999999999999999999999';

export interface LogPosition {
  blockNumber: number;
  blockHash?: string;
  transactionHash: string;
  transactionIndex?: number;
  logIndex: number;
  removed?: boolean;
}

/** Distinct, deterministic hashes: a fixed prefix plus the zero-padded seed. */
export function blockHashOf(block: number): string {
  return `0x${'b'.repeat(48)}${block.toString(16).padStart(16, '0')}`;
}

export function txHashOf(seed: number): string {
  return `0x${'a'.repeat(48)}${seed.toString(16).padStart(16, '0')}`;
}

function logOf(
  address: string,
  encoded: { data: string; topics: string[] },
  position: LogPosition
): Log {
  return {
    blockNumber: position.blockNumber,
    blockHash: position.blockHash ?? blockHashOf(position.blockNumber),
    transactionIndex: position.transactionIndex ?? 0,
    transactionHash: position.transactionHash,
    address,
    data: encoded.data,
    topics: encoded.topics,
    logIndex: position.logIndex,
    removed: position.removed ?? false
  };
}

export function erc721TransferLog(
  address: string,
  from: string,
  to: string,
  tokenId: bigint | number | string,
  position: LogPosition
): Log {
  return logOf(
    address,
    IFACE.encodeEventLog('Transfer', [from, to, BigInt(tokenId)]),
    position
  );
}

export function erc1155TransferSingleLog(
  address: string,
  from: string,
  to: string,
  tokenId: bigint | number | string,
  amount: bigint | number | string,
  position: LogPosition
): Log {
  return logOf(
    address,
    IFACE.encodeEventLog('TransferSingle', [
      FIXTURE_OPERATOR,
      from,
      to,
      BigInt(tokenId),
      BigInt(amount)
    ]),
    position
  );
}

export function erc1155TransferBatchLog(
  address: string,
  from: string,
  to: string,
  tokenIds: (bigint | number | string)[],
  amounts: (bigint | number | string)[],
  position: LogPosition
): Log {
  return logOf(
    address,
    IFACE.encodeEventLog('TransferBatch', [
      FIXTURE_OPERATOR,
      from,
      to,
      tokenIds.map((id) => BigInt(id)),
      amounts.map((amount) => BigInt(amount))
    ]),
    position
  );
}
