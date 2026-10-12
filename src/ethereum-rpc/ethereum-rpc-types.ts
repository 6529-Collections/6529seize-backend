import type { TransactionResponse as EthersTransactionResponse } from 'ethers';

export type TransactionResponse = EthersTransactionResponse;
export type Log = {
  blockNumber: number;
  blockHash: string;
  transactionIndex: number;
  transactionHash: string;
  address: string;
  data: string;
  topics: readonly string[];
  logIndex: number;
  removed: boolean;
};

/**
 * Block tag accepted by `getBlock`. Either a block number, a block hash, or
 * one of the string tags "latest" / "pending" / "earliest" / "finalized" /
 * "safe".
 */
export type BlockTag = number | string;

export type Block = {
  number: number;
  hash: string | null;
  parentHash: string;
  timestamp: number;
  nonce: string;
  difficulty: bigint;
  gasLimit: bigint;
  gasUsed: bigint;
  miner: string;
  extraData: string;
  baseFeePerGas: bigint | null;
  transactions: readonly string[];
};
