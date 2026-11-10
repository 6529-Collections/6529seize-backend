import { FetchRequest, JsonRpcProvider } from 'ethers';
import { getEthereumRpcUrl } from '@/ethereum-rpc/ethereum-rpc.config';

const providers = new Map<string, JsonRpcProvider>();

/**
 * Shared ordinary-RPC boundary. Call only after runtime secrets are loaded.
 */
export function getEthereumRpcProvider(chainId: number = 1): JsonRpcProvider {
  const url = getEthereumRpcUrl(chainId);
  const cacheKey = `${chainId}:${url}`;
  let provider = providers.get(cacheKey);
  if (!provider || provider.destroyed) {
    // Supplying the expected chain retains ethers' network-mismatch checks.
    // Do not use staticNetwork: it would trust a misconfigured endpoint.
    // Off-chain (CCIP-Read) lookups stay disabled on the shared provider:
    // their gateway URLs come from on-chain resolver data. ENS refresh uses
    // its own provider with a public-network gateway transport.
    provider = createEthereumRpcProvider(chainId, { disableCcipRead: true });
    providers.set(cacheKey, provider);
  }
  return provider;
}

/**
 * Isolated transport for callers with strict deadlines and their own
 * lifecycle. CCIP-Read is off unless a caller passes `disableCcipRead: false`.
 */
export function createEthereumRpcProvider(
  chainId: number = 1,
  options: {
    timeoutMs?: number;
    maxAttempts?: number;
    disableCcipRead?: boolean;
  } = {}
): JsonRpcProvider {
  const request = new FetchRequest(getEthereumRpcUrl(chainId));
  if (options.timeoutMs !== undefined) request.timeout = options.timeoutMs;
  if (options.maxAttempts !== undefined)
    request.setThrottleParams({ maxAttempts: options.maxAttempts });
  const provider = new JsonRpcProvider(request, chainId);
  provider.disableCcipRead = options.disableCcipRead ?? true;
  return provider;
}
