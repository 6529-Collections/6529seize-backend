import {
  JsonRpcProvider,
  Log as EthersLog,
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
export type Log = EthersLog & { logIndex: number };

type AlchemyConfig = {
  network?: Network;
  apiKey?: string;
  maxRetries?: number;
};

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

async function postAlchemyRpc<T>(
  network: Network,
  apiKey: string,
  method: string,
  params: unknown[]
): Promise<T> {
  const response = await fetch(getRpcUrl(network, apiKey), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params
    })
  });

  const json = (await response.json()) as {
    result?: T;
    error?: {
      message?: string;
      code?: number;
    };
  };
  if (!response.ok || json.error) {
    const message =
      json?.error?.message ??
      `Alchemy method ${method} failed with HTTP ${response.status}`;
    const error = new Error(message) as Error & {
      status?: number;
      code?: number;
    };
    error.status = response.status;
    error.code = json?.error?.code;
    throw error;
  }
  return json.result as T;
}

class AlchemyCoreClient {
  private readonly provider: JsonRpcProvider;

  constructor(
    private readonly network: Network,
    private readonly apiKey: string
  ) {
    const rpcUrl = getRpcUrl(network, apiKey);
    if (!providers.has(rpcUrl)) {
      providers.set(rpcUrl, new JsonRpcProvider(rpcUrl));
    }
    this.provider = providers.get(rpcUrl)!;
  }

  async getBlockNumber(): Promise<number> {
    return await this.provider.getBlockNumber();
  }

  async getBlock(blockNumber: number): Promise<{ timestamp: number }> {
    const block = await this.provider.getBlock(blockNumber);
    if (!block) {
      throw new Error(`Block ${blockNumber} not found`);
    }
    return { timestamp: Number(block.timestamp) };
  }

  async getTransaction(
    hash: string
  ): Promise<EthersTransactionResponse | null> {
    return await this.provider.getTransaction(hash);
  }

  async getTransactionReceipt(
    hash: string
  ): Promise<TransactionReceipt | null> {
    return await this.provider.getTransactionReceipt(hash);
  }

  async getLogs(filter: {
    address?: string;
    fromBlock?: string;
    toBlock?: string;
    topics?: (string | string[] | null)[];
  }): Promise<Log[]> {
    const logs = await this.provider.getLogs(filter);
    return logs.map((log) => ({
      ...log,
      logIndex: log.index
    }));
  }

  async resolveName(name: string): Promise<string | null> {
    return await this.provider.resolveName(name);
  }

  async getAssetTransfers(
    params: AssetTransfersWithMetadataParams
  ): Promise<AssetTransfersResponse> {
    return await postAlchemyRpc<AssetTransfersResponse>(
      this.network,
      this.apiKey,
      'alchemy_getAssetTransfers',
      [params]
    );
  }
}

class AlchemyNftClient {
  constructor(
    private readonly network: Network,
    private readonly apiKey: string
  ) {}

  async getNftMetadata(
    contractAddress: string,
    tokenId: string,
    options?: Record<string, unknown>
  ): Promise<Nft> {
    return await postAlchemyRpc<Nft>(
      this.network,
      this.apiKey,
      'alchemy_getNFTMetadata',
      [contractAddress, tokenId, options]
    );
  }

  async getContractMetadata(contractAddress: string): Promise<NftContract> {
    return await postAlchemyRpc<NftContract>(
      this.network,
      this.apiKey,
      'alchemy_getContractMetadata',
      [contractAddress]
    );
  }

  async searchContractMetadata(query: string): Promise<Record<string, any>> {
    return await postAlchemyRpc<Record<string, any>>(
      this.network,
      this.apiKey,
      'alchemy_searchContractMetadata',
      [query]
    );
  }

  async getNftsForOwner(
    owner: string,
    options?: Record<string, unknown>
  ): Promise<Record<string, any>> {
    return await postAlchemyRpc<Record<string, any>>(
      this.network,
      this.apiKey,
      'alchemy_getNFTsForOwner',
      [owner, options]
    );
  }

  async getNftMetadataBatch(
    tokens: { contractAddress: string; tokenId: string }[]
  ): Promise<{ nfts: Nft[] }> {
    return await postAlchemyRpc<{ nfts: Nft[] }>(
      this.network,
      this.apiKey,
      'alchemy_getNFTMetadataBatch',
      [tokens]
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
    this.config = {
      ...config,
      network,
      apiKey
    };
    this.core = new AlchemyCoreClient(network, apiKey);
    this.nft = new AlchemyNftClient(network, apiKey);
  }
}

export function fromHex(value: string): number {
  return Number.parseInt(value, 16);
}
