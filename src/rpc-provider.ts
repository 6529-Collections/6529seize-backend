import { JsonRpcProvider } from 'ethers';

const ALCHEMY_MAINNET_PATH = 'eth-mainnet';
const RPC_6529_URL = 'https://rpc1.6529.io';

const providers = new Map<string, JsonRpcProvider>();

function getAlchemyPathForNetwork(networkIdOrName: number | string): string {
  if (typeof networkIdOrName === 'number') {
    switch (networkIdOrName) {
      case 1:
        return ALCHEMY_MAINNET_PATH;
      case 11155111:
        return 'eth-sepolia';
      default:
        throw new Error(`Unsupported network id: ${networkIdOrName}`);
    }
  }

  const networkPath = networkIdOrName.trim();
  if (!networkPath) {
    throw new Error('Network name cannot be empty');
  }
  return networkPath;
}

function getAlchemyUrl(networkIdOrName: number | string): string {
  const alchemyApiKey = process.env.ALCHEMY_API_KEY;
  if (!alchemyApiKey) {
    throw new Error('ALCHEMY_API_KEY is not set');
  }
  const networkPath = getAlchemyPathForNetwork(networkIdOrName);
  return `https://${networkPath}.g.alchemy.com/v2/${alchemyApiKey}`;
}

function getOrCreateProvider(url: string): JsonRpcProvider {
  if (!providers.has(url)) {
    providers.set(url, new JsonRpcProvider(url));
  }
  return providers.get(url)!;
}

export function getRpcProvider(
  networkIdOrName: number | string = 1
): JsonRpcProvider {
  return getOrCreateProvider(getAlchemyUrl(networkIdOrName));
}

export function get6529RpcProvider(): JsonRpcProvider {
  return getOrCreateProvider(RPC_6529_URL);
}
