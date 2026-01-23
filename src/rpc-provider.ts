import { JsonRpcProvider } from 'ethers';

const providers = new Map<number, JsonRpcProvider>();

function getAlchemyPathForNetwork(networkId: number): string {
  switch (networkId) {
    case 1:
      return 'eth-mainnet';
    case 11155111:
      return 'eth-sepolia';
    default:
      throw new Error(`Unsupported network id: ${networkId}`);
  }
}

function getAlchemyUrl(networkId: number): string {
  const alchemyApiKey = process.env.ALCHEMY_API_KEY;
  if (!alchemyApiKey) {
    throw new Error('ALCHEMY_API_KEY is not set');
  }
  const networkPrefix = getAlchemyPathForNetwork(networkId);
  return `https://${networkPrefix}.g.alchemy.com/v2/${alchemyApiKey}`;
}

export function getRpcProvider(networkId = 1): JsonRpcProvider {
  if (!providers.has(networkId)) {
    const provider = new JsonRpcProvider(getAlchemyUrl(networkId));
    providers.set(networkId, provider);
  }
  return providers.get(networkId)!;
}
