import axios, { AxiosError, AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import {
  JsonRpcProvider,
  TransactionReceipt,
  TransactionResponse as EthersTransactionResponse
} from 'ethers';

export enum Network {
  ETH_MAINNET = 'eth-mainnet',
  ETH_SEPOLIA = 'eth-sepolia',
  ETH_GOERLI = 'eth-goerli'
}

export enum AssetTransfersCategory {
  EXTERNAL = 'external',
  INTERNAL = 'internal',
  ERC20 = 'erc20',
  ERC721 = 'erc721',
  ERC1155 = 'erc1155',
  SPECIALNFT = 'specialnft'
}

export enum SortingOrder {
  ASCENDING = 'asc',
  DESCENDING = 'desc'
}

export type AssetTransfersWithMetadataParams = {
  fromBlock?: string;
  toBlock?: string;
  fromAddress?: string;
  toAddress?: string;
  contractAddresses?: string[];
  category?: AssetTransfersCategory[];
  excludeZeroValue?: boolean;
  maxCount?: number;
  pageKey?: string;
  order?: SortingOrder;
  withMetadata?: boolean;
};

export type AssetTransfersWithMetadataResult = {
  blockNum: string;
  hash: string;
  from: string;
  to: string;
  value?: number;
  metadata: {
    blockTimestamp: string;
  };
  rawContract: {
    address: string;
  };
  erc721TokenId?: string;
  erc1155Metadata?: {
    tokenId: string;
    value: string;
  }[];
};

export type AssetTransfersResponse = {
  transfers: AssetTransfersWithMetadataResult[];
  pageKey?: string;
};

export type Nft = Record<string, any>;
export type NftContract = Record<string, any>;
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

type AlchemyConfig = {
  network?: Network;
  apiKey?: string;
  maxRetries?: number;
};

const DEFAULT_MAX_RETRIES = 3;
const PROVIDER_RETRYABLE_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'TIMEOUT'
]);

const providers = new Map<string, JsonRpcProvider>();

function requireApiKey(apiKey?: string): string {
  if (!apiKey) {
    throw new Error('ALCHEMY_API_KEY is not set');
  }
  return apiKey;
}

function getRpcUrl(network: Network, apiKey: string): string {
  return `https://${network}.g.alchemy.com/v2/${apiKey}`;
}

function getNftApiBaseUrl(network: Network, apiKey: string): string {
  return `https://${network}.g.alchemy.com/nft/v3/${apiKey}`;
}

function toNftQueryParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

type JsonRpcEnvelope<T> = {
  result?: T;
  error?: {
    message?: string;
    code?: number;
  };
};

/**
 * Retryable statuses: 429 (rate limit) and 5xx (transient server errors).
 * Network errors and idempotent request errors are handled by the
 * axios-retry helpers.
 */
function isRetryableAlchemyError(error: AxiosError): boolean {
  const status = error.response?.status ?? 0;
  return (
    axiosRetry.isNetworkError(error) ||
    axiosRetry.isRetryableError(error) ||
    status === 429 ||
    status >= 500
  );
}

function createAlchemyAxios(maxRetries: number): AxiosInstance {
  const instance = axios.create({
    headers: { 'Content-Type': 'application/json' }
  });
  axiosRetry(instance, {
    retries: maxRetries,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: isRetryableAlchemyError
  });
  return instance;
}

function normalizeAssetTransfersParams(
  params: AssetTransfersWithMetadataParams
): Record<string, unknown> {
  return {
    ...params,
    maxCount:
      params.maxCount != null ? `0x${params.maxCount.toString(16)}` : undefined
  };
}

function getProviderRetryDelay(retryCount: number): number {
  return axiosRetry.exponentialDelay(retryCount);
}

function getNestedErrorRecord(error: unknown):
  | {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      message?: unknown;
      shortMessage?: unknown;
      error?: unknown;
    }
  | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  return error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    shortMessage?: unknown;
    error?: unknown;
  };
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

function getProviderErrorMessage(error: unknown): string {
  const topLevel = getNestedErrorRecord(error);
  const nested = getNestedErrorRecord(topLevel?.error);
  return `${String(topLevel?.message ?? '')} ${String(
    topLevel?.shortMessage ?? ''
  )} ${String(nested?.message ?? '')}`.toLowerCase();
}

function isRetryableProviderError(error: unknown): boolean {
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

async function postAlchemyRpc<T>(
  http: AxiosInstance,
  network: Network,
  apiKey: string,
  method: string,
  params: unknown[]
): Promise<T> {
  try {
    const response = await http.post<JsonRpcEnvelope<T>>(
      getRpcUrl(network, apiKey),
      { jsonrpc: '2.0', id: 1, method, params },
      { headers: { 'Content-Type': 'application/json' } }
    );
    const json = response.data;
    if (json.error) {
      const err = new Error(
        json.error.message ?? `Alchemy method ${method} failed`
      ) as Error & { status?: number; code?: number };
      err.status = response.status;
      err.code = json.error.code;
      throw err;
    }
    return json.result as T;
  } catch (e) {
    if (e instanceof AxiosError) {
      const data = e.response?.data as JsonRpcEnvelope<T> | undefined;
      const message =
        data?.error?.message ??
        e.message ??
        `Alchemy method ${method} failed with HTTP ${e.response?.status}`;
      const err = new Error(message) as Error & {
        status?: number;
        code?: number;
      };
      err.status = e.response?.status;
      err.code = data?.error?.code;
      throw err;
    }
    throw e;
  }
}

async function getNftRest<T>(
  http: AxiosInstance,
  network: Network,
  apiKey: string,
  path: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  try {
    const response = await http.get<T>(
      `${getNftApiBaseUrl(network, apiKey)}/${path}`,
      {
        params: toNftQueryParams(params),
        // Repeat array params (e.g. contractAddresses) as `key=a&key=b`,
        // which is what Alchemy's NFT REST API expects.
        paramsSerializer: {
          indexes: null
        }
      }
    );
    return response.data;
  } catch (e) {
    throw toAlchemyError(e, `Alchemy NFT API ${path}`);
  }
}

async function postNftRest<T>(
  http: AxiosInstance,
  network: Network,
  apiKey: string,
  path: string,
  body: unknown
): Promise<T> {
  try {
    const response = await http.post<T>(
      `${getNftApiBaseUrl(network, apiKey)}/${path}`,
      body,
      { headers: { 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (e) {
    throw toAlchemyError(e, `Alchemy NFT API ${path}`);
  }
}

function toAlchemyError(e: unknown, context: string): Error {
  if (e instanceof AxiosError) {
    const data = e.response?.data as
      | { message?: string; error?: string | { message?: string } }
      | undefined;
    const nestedMessage =
      typeof data?.error === 'string' ? data.error : data?.error?.message;
    const message =
      data?.message ??
      nestedMessage ??
      e.message ??
      `${context} failed with HTTP ${e.response?.status}`;
    const err = new Error(message) as Error & { status?: number };
    err.status = e.response?.status;
    return err;
  }
  return e instanceof Error ? e : new Error(`${context} failed`);
}

class AlchemyCoreClient {
  private readonly provider: JsonRpcProvider;

  constructor(
    private readonly network: Network,
    private readonly apiKey: string,
    private readonly http: AxiosInstance,
    private readonly maxRetries: number
  ) {
    const rpcUrl = getRpcUrl(network, apiKey);
    if (!providers.has(rpcUrl)) {
      providers.set(rpcUrl, new JsonRpcProvider(rpcUrl));
    }
    this.provider = providers.get(rpcUrl)!;
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

  async getAssetTransfers(
    params: AssetTransfersWithMetadataParams
  ): Promise<AssetTransfersResponse> {
    return await postAlchemyRpc<AssetTransfersResponse>(
      this.http,
      this.network,
      this.apiKey,
      'alchemy_getAssetTransfers',
      [normalizeAssetTransfersParams(params)]
    );
  }
}

class AlchemyNftClient {
  constructor(
    private readonly network: Network,
    private readonly apiKey: string,
    private readonly http: AxiosInstance
  ) {}

  async getNftMetadata(
    contractAddress: string,
    tokenId: string,
    options?: Record<string, unknown>
  ): Promise<Nft> {
    return await getNftRest<Nft>(
      this.http,
      this.network,
      this.apiKey,
      'getNFTMetadata',
      {
        contractAddress,
        tokenId,
        ...options
      }
    );
  }

  async getContractMetadata(contractAddress: string): Promise<NftContract> {
    return await getNftRest<NftContract>(
      this.http,
      this.network,
      this.apiKey,
      'getContractMetadata',
      { contractAddress }
    );
  }

  async searchContractMetadata(query: string): Promise<Record<string, any>> {
    return await getNftRest<Record<string, any>>(
      this.http,
      this.network,
      this.apiKey,
      'searchContractMetadata',
      { query }
    );
  }

  async getNftsForOwner(
    owner: string,
    options?: Record<string, unknown>
  ): Promise<Record<string, any>> {
    return await getNftRest<Record<string, any>>(
      this.http,
      this.network,
      this.apiKey,
      'getNFTsForOwner',
      { owner, ...options }
    );
  }

  async getNftMetadataBatch(
    tokens: { contractAddress: string; tokenId: string }[]
  ): Promise<{ nfts: Nft[] }> {
    return await postNftRest<{ nfts: Nft[] }>(
      this.http,
      this.network,
      this.apiKey,
      'getNFTMetadataBatch',
      { tokens }
    );
  }
}

export class Alchemy {
  public readonly config: Required<Pick<AlchemyConfig, 'network'>> &
    Omit<AlchemyConfig, 'network'>;
  public readonly core: AlchemyCoreClient;
  public readonly nft: AlchemyNftClient;

  constructor(config: AlchemyConfig = {}) {
    const network = config.network ?? Network.ETH_MAINNET;
    const apiKey = requireApiKey(config.apiKey ?? process.env.ALCHEMY_API_KEY);
    const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.config = {
      ...config,
      network,
      apiKey,
      maxRetries
    };
    const http = createAlchemyAxios(maxRetries);
    this.core = new AlchemyCoreClient(network, apiKey, http, maxRetries);
    this.nft = new AlchemyNftClient(network, apiKey, http);
  }
}

export function fromHex(value: string): number {
  return Number.parseInt(value, 16);
}
