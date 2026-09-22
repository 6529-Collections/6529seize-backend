import axiosRetry from 'axios-retry';
import type {
  TransactionReceipt,
  TransactionResponse as EthersTransactionResponse
} from 'ethers';
import { Network, getRpcChainId } from '@/ethereum-rpc/ethereum-rpc-network';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
import type { Block, BlockTag, Log } from '@/ethereum-rpc/ethereum-rpc-types';

const PROVIDER_RETRYABLE_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'TIMEOUT'
]);

function getProviderRetryDelay(retryCount: number): number {
  return axiosRetry.exponentialDelay(retryCount);
}

type ProviderErrorRecord = {
  code?: unknown;
  status?: unknown;
  statusCode?: unknown;
  message?: unknown;
  shortMessage?: unknown;
  event?: unknown;
  error?: unknown;
};

function getNestedErrorRecord(error: unknown): ProviderErrorRecord | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return error as ProviderErrorRecord;
}

function extractProviderErrorStatus(error: unknown): number | undefined {
  const topLevel = getNestedErrorRecord(error);
  const nested = getNestedErrorRecord(topLevel?.error);
  const candidate = [
    topLevel?.status,
    topLevel?.statusCode,
    nested?.status,
    nested?.statusCode
  ].find((value) => typeof value === 'number');
  return typeof candidate === 'number' ? candidate : undefined;
}

function extractProviderErrorCodes(error: unknown): string[] {
  const topLevel = getNestedErrorRecord(error);
  const nested = getNestedErrorRecord(topLevel?.error);
  return [topLevel?.code, nested?.code].filter(
    (value): value is string => typeof value === 'string'
  );
}

function extractString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getProviderErrorMessage(error: unknown): string {
  const topLevel = getNestedErrorRecord(error);
  const nested = getNestedErrorRecord(topLevel?.error);
  return [
    extractString(topLevel?.message),
    extractString(topLevel?.shortMessage),
    extractString(nested?.message)
  ]
    .join(' ')
    .toLowerCase();
}

function isRetryableProviderError(error: unknown): boolean {
  const record = getNestedErrorRecord(error);
  if (record?.code === 'NETWORK_ERROR' && record.event === 'changed')
    return false;
  const status = extractProviderErrorStatus(error);
  if (status === 429 || (status != null && status >= 500)) {
    return true;
  }

  if (
    extractProviderErrorCodes(error).some((code) =>
      PROVIDER_RETRYABLE_ERROR_CODES.has(code)
    )
  ) {
    return true;
  }

  const message = getProviderErrorMessage(error);
  return [
    '429',
    '502',
    '503',
    '504',
    'econnaborted',
    'econnreset',
    'enotfound',
    'etimedout',
    'network',
    'rate limit',
    'socket hang up',
    'timed out',
    'timeout',
    'too many requests'
  ].some((snippet) => message.includes(snippet));
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Standard reads with the legacy retry and response-shape contracts. */
export class EthereumRpcClient {
  constructor(
    private readonly network: Network = Network.ETH_MAINNET,
    private readonly maxRetries = 10
  ) {}
  private get provider() {
    return getEthereumRpcProvider(getRpcChainId(this.network));
  }
  private async withProviderRetries<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    let retryCount = 0;

    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (retryCount >= this.maxRetries || !isRetryableProviderError(error)) {
          throw error;
        }
        retryCount += 1;
        await sleep(getProviderRetryDelay(retryCount));
      }
    }
  }

  async getBlockNumber(): Promise<number> {
    return await this.withProviderRetries(() => this.provider.getBlockNumber());
  }

  async getBlock(blockHashOrBlockTag: BlockTag): Promise<Block> {
    const block = await this.withProviderRetries(() =>
      this.provider.getBlock(blockHashOrBlockTag)
    );
    if (!block) {
      throw new Error(`Block ${String(blockHashOrBlockTag)} not found`);
    }
    return {
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: Number(block.timestamp),
      nonce: block.nonce,
      difficulty: block.difficulty,
      gasLimit: block.gasLimit,
      gasUsed: block.gasUsed,
      miner: block.miner,
      extraData: block.extraData,
      baseFeePerGas: block.baseFeePerGas,
      transactions: block.transactions
    };
  }

  async getTransaction(
    hash: string
  ): Promise<EthersTransactionResponse | null> {
    return await this.withProviderRetries(() =>
      this.provider.getTransaction(hash)
    );
  }

  async getTransactionReceipt(
    hash: string
  ): Promise<TransactionReceipt | null> {
    return await this.withProviderRetries(() =>
      this.provider.getTransactionReceipt(hash)
    );
  }

  async getLogs(filter: {
    address?: string;
    fromBlock?: string;
    toBlock?: string;
    topics?: (string | string[] | null)[];
  }): Promise<Log[]> {
    const logs = await this.withProviderRetries(() =>
      this.provider.getLogs(filter)
    );
    return logs.map((log) => ({
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      transactionIndex: log.transactionIndex,
      transactionHash: log.transactionHash,
      address: log.address,
      data: log.data,
      topics: log.topics,
      logIndex: log.index,
      removed: log.removed
    }));
  }

  async resolveName(name: string): Promise<string | null> {
    return await this.withProviderRetries(() =>
      this.provider.resolveName(name)
    );
  }
}
export function getEthereumRpcClient(
  network: Network = Network.ETH_MAINNET
): EthereumRpcClient {
  return new EthereumRpcClient(network);
}
