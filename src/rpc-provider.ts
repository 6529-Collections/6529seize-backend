import { assertUnreachable } from '@/assertions';
import { Network } from 'alchemy-sdk';
import { JsonRpcProvider } from 'ethers';

const RPC_6529_URL = 'https://rpc1.6529.io';

const providers = new Map<string, JsonRpcProvider>();

export type SupportedRpcNetwork =
  | Network.ETH_MAINNET
  | Network.ETH_SEPOLIA
  | Network.ETH_GOERLI;

function getAlchemyPathForNetwork(network: SupportedRpcNetwork): string {
  switch (network) {
    case Network.ETH_MAINNET:
      return 'eth-mainnet';
    case Network.ETH_SEPOLIA:
      return 'eth-sepolia';
    case Network.ETH_GOERLI:
      return 'eth-goerli';
    default:
      throw assertUnreachable(network);
  }
}

function getAlchemyUrl(network: SupportedRpcNetwork): string {
  const alchemyApiKey = process.env.ALCHEMY_API_KEY;
  if (!alchemyApiKey) {
    throw new Error('ALCHEMY_API_KEY is not set');
  }
  const networkPath = getAlchemyPathForNetwork(network);
  return `https://${networkPath}.g.alchemy.com/v2/${alchemyApiKey}`;
}

function getOrCreateProvider(url: string): JsonRpcProvider {
  if (!providers.has(url)) {
    providers.set(url, new JsonRpcProvider(url));
  }
  return providers.get(url)!;
}

export function getRpcProvider(
  network: SupportedRpcNetwork = Network.ETH_MAINNET
): JsonRpcProvider {
  return getOrCreateProvider(getAlchemyUrl(network));
}

export function get6529RpcProvider(): JsonRpcProvider {
  return getOrCreateProvider(RPC_6529_URL);
}
