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
    provider = createEthereumRpcProvider(chainId);
    providers.set(cacheKey, provider);
  }
  return provider;
}

/** Isolated transport for callers with strict deadlines and their own lifecycle. */
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
  provider.disableCcipRead = options.disableCcipRead ?? false;
  return provider;
}
