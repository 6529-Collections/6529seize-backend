import { JsonRpcProvider } from 'ethers';
import { Network, getRpcChainId } from '@/ethereum-rpc/ethereum-rpc-network';

const providers = new Map<string, JsonRpcProvider>();
function providerFor(url: string, chainId: number): JsonRpcProvider {
  const key = chainId + ':' + url;
  let provider = providers.get(key);
  if (!provider || provider.destroyed) {
    provider = new JsonRpcProvider(url, chainId);
    providers.set(key, provider);
  }
  return provider;
}

/** Non-standard trace_block only. This is NOT the ordinary RPC boundary. */
export function getAlchemyTraceProvider(network: Network): JsonRpcProvider {
  const chainId = getRpcChainId(network);
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) throw new Error('ALCHEMY_API_KEY is required for Alchemy tracing');
  return providerFor(`https://${network}.g.alchemy.com/v2/${key}`, chainId);
}

/** Preserve the existing mainnet trace provider; never send testnet traces here. */
export function get6529TraceProvider(network: Network): JsonRpcProvider {
  if (network !== Network.ETH_MAINNET)
    throw new Error('6529 tracing supports mainnet only');
  return providerFor('https://rpc1.6529.io', 1);
}
