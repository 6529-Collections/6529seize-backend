import { JsonRpcProvider } from 'ethers';
import { getEthereumRpcUrl } from '@/ethereum-rpc/ethereum-rpc.config';

const providers = new Map<string, JsonRpcProvider>();

/**
 * Additive ordinary-RPC boundary. Call only after runtime secrets are loaded.
 * Existing callers remain on rpc-provider.ts until their migration PRs.
 */
export function getEthereumRpcProvider(chainId: number = 1): JsonRpcProvider {
  const url = getEthereumRpcUrl(chainId);
  const cacheKey = `${chainId}:${url}`;
  let provider = providers.get(cacheKey);
  if (!provider) {
    // Supplying the expected chain retains ethers' network-mismatch checks.
    // Do not use staticNetwork: it would trust a misconfigured endpoint.
    provider = new JsonRpcProvider(url, chainId);
    providers.set(cacheKey, provider);
  }
  return provider;
}
