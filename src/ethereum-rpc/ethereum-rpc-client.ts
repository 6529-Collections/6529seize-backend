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

export const ENS_RESOLVE_NAME_TIMEOUT_MS = 10_000;
export const ENS_RESOLVE_DEADLINE_CODE = 'ENS_RESOLVE_DEADLINE';

function ensResolveDeadlineError(): Error {
  // Deliberately not matched by isRetryableProviderError.
  return Object.assign(new Error('ENS name resolution deadline exceeded'), {
    code: ENS_RESOLVE_DEADLINE_CODE
  });
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
    operation: () => Promise<T>,
    retryCount = 0
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (retryCount >= this.maxRetries || !isRetryableProviderError(error)) {
        throw error;
      }
      const nextRetryCount = retryCount + 1;
      await sleep(getProviderRetryDelay(nextRetryCount));
      return this.withProviderRetries(operation, nextRetryCount);
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
    address?: string | string[];
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

  /**
   * Read-only `eth_call`. A block number `blockTag` reads historical state,
   * which needs an archive-capable endpoint.
   */
  async call(
    transaction: { to: string; data: string },
    blockTag: BlockTag = 'latest'
  ): Promise<string> {
    return await this.withProviderRetries(() =>
      this.provider.call({ ...transaction, blockTag })
    );
  }

  /**
   * Bounded so a request path cannot wait on slow resolvers or retries for
   * longer than ENS_RESOLVE_NAME_TIMEOUT_MS.
   */
  async resolveName(
    name: string,
    timeoutMs = ENS_RESOLVE_NAME_TIMEOUT_MS
  ): Promise<string | null> {
    const deadlineAt = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(ensResolveDeadlineError()), timeoutMs);
    });
    const lookup = this.withProviderRetries(() => {
      // Stops further retries once the caller has been answered.
      if (Date.now() >= deadlineAt) throw ensResolveDeadlineError();
      return this.provider.resolveName(name);
    });
    // When the deadline wins, the lookup may still settle later; its outcome
    // is no longer observed, so it must not surface as an unhandled rejection.
    lookup.catch(() => undefined);
    try {
      return await Promise.race([lookup, deadline]);
    } finally {
      // When the lookup wins, the deadline never fires and never rejects.
      clearTimeout(timer);
    }
  }
}
export function getEthereumRpcClient(
  network: Network = Network.ETH_MAINNET
): EthereumRpcClient {
  return new EthereumRpcClient(network);
}
