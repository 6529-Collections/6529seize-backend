import axios, { AxiosError, AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { Network } from '@/ethereum-rpc/ethereum-rpc-network';

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
  uniqueId: string;
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
type AlchemyConfig = {
  network?: Network;
  apiKey?: string;
  maxRetries?: number;
  timeoutMs?: number;
};

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
function requireApiKey(apiKey?: string): string {
  if (!apiKey) {
    throw new Error('ALCHEMY_API_KEY is not set');
  }
  return apiKey;
}

function getAlchemyIndexedRpcUrl(network: Network, apiKey: string): string {
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

function serializeNftQueryValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return value.toString();
  }
  throw new TypeError('Unsupported Alchemy NFT query parameter value');
}

function serializeNftQueryParams(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        searchParams.append(`${key}[]`, serializeNftQueryValue(item));
      }
      continue;
    }
    searchParams.append(key, serializeNftQueryValue(value));
  }
  return searchParams.toString();
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

function createAlchemyAxios(
  maxRetries: number,
  timeoutMs: number
): AxiosInstance {
  const instance = axios.create({
    headers: { 'Content-Type': 'application/json' },
    timeout: timeoutMs
  });
  axiosRetry(instance, {
    retries: maxRetries,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: isRetryableAlchemyError,
    shouldResetTimeout: true
  });
  return instance;
}

function normalizeAssetTransfersParams(
  params: AssetTransfersWithMetadataParams
): Record<string, unknown> {
  const maxCount =
    params.maxCount == null ? undefined : `0x${params.maxCount.toString(16)}`;
  return {
    ...params,
    maxCount
  };
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
      getAlchemyIndexedRpcUrl(network, apiKey),
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
        paramsSerializer: {
          serialize: serializeNftQueryParams
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

/** Alchemy-only indexed methods, deliberately separate from standard RPC. */
class AlchemyIndexedClient {
  constructor(
    private readonly network: Network,
    private readonly apiKey: string,
    private readonly http: AxiosInstance
  ) {}

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
  public readonly core: AlchemyIndexedClient;
  public readonly nft: AlchemyNftClient;

  constructor(config: AlchemyConfig = {}) {
    const network = config.network ?? Network.ETH_MAINNET;
    const apiKey = requireApiKey(config.apiKey ?? process.env.ALCHEMY_API_KEY);
    const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.config = {
      ...config,
      network,
      apiKey,
      maxRetries,
      timeoutMs
    };
    const http = createAlchemyAxios(maxRetries, timeoutMs);
    this.core = new AlchemyIndexedClient(network, apiKey, http);
    this.nft = new AlchemyNftClient(network, apiKey, http);
  }
}

export function fromHex(value: string): number {
  return Number.parseInt(value, 16);
}
