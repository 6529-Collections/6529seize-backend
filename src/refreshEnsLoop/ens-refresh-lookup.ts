import {
  FetchRequest,
  FetchResponse,
  JsonRpcProvider,
  makeError
} from 'ethers';
import { performance } from 'node:perf_hooks';
import { getEthereumRpcUrl } from '@/ethereum-rpc/ethereum-rpc.config';
import { EnsLookupResult, lookupPrimaryEnsNameResult } from '@/ens-lookup';
import { text } from '@/text';
import {
  abortableEnsGetUrl,
  publicEnsGetUrl
} from '@/refreshEnsLoop/ens-refresh-transport';

function gatewayFailure() {
  return makeError('ENS gateway unavailable', 'OFFCHAIN_FAULT', {
    reason: '500_SERVER_ERROR',
    transaction: {}
  });
}

function gatewayData(response: FetchResponse): string | null {
  try {
    const result = response.bodyJson as { data?: unknown };
    return typeof result?.data === 'string' && result.data ? result.data : null;
  } catch {
    return null;
  }
}

async function readGateway(request: FetchRequest): Promise<string | null> {
  let response: FetchResponse;
  try {
    response = await request.send();
  } catch {
    return null;
  }
  const data = gatewayData(response);
  if (data) return data;
  // Preserve ethers' gateway fallback contract: 4xx stops, 5xx may try next URL.
  if (response.statusCode >= 400 && response.statusCode < 500) {
    throw makeError('ENS gateway resource unavailable', 'OFFCHAIN_FAULT', {
      reason: '404_MISSING_RESOURCE',
      transaction: {}
    });
  }
  return null;
}

/** Owns every RPC and CCIP request for one refresh lookup. */
export function createEnsRefreshProvider(timeoutMs: number): JsonRpcProvider {
  const provider = new JsonRpcProvider(getEthereumRpcUrl(1), 1);
  const requests = new Set<FetchRequest>();
  const deadline = performance.now() + timeoutMs;
  const getConnection = provider._getConnection.bind(provider);
  const destroy = provider.destroy.bind(provider);

  function track(request: FetchRequest, publicOnly = false): FetchRequest {
    const remainingMs = deadline - performance.now();
    if (provider.destroyed || remainingMs <= 0) throw gatewayFailure();
    request.timeout = Math.max(1, Math.ceil(remainingMs));
    request.setThrottleParams({ maxAttempts: 1 });
    request.getUrlFunc = publicOnly ? publicEnsGetUrl : abortableEnsGetUrl;
    requests.add(request);
    return request;
  }

  provider._getConnection = () => track(getConnection());

  // Ethers creates separate FetchRequests for CCIP gateways. Own those too so
  // destroying this isolated provider cancels off-chain reads as well as RPC.
  provider.ccipReadFetch = async (
    tx: Parameters<JsonRpcProvider['ccipReadFetch']>[0],
    calldata: string,
    urls: string[]
  ): Promise<string | null> => {
    if (provider.disableCcipRead || !urls.length || !tx.to) return null;
    const sender = tx.to.toLowerCase();
    const data = calldata.toLowerCase();
    for (const url of urls) {
      const href = url.replace('{sender}', sender).replace('{data}', data);
      const request = track(new FetchRequest(href), true);
      if (!url.includes('{data}')) request.body = { data, sender };
      const result = await readGateway(request);
      if (result) return result;
    }
    throw gatewayFailure();
  };

  provider.destroy = () => {
    if (provider.destroyed) return;
    requests.forEach((request) => {
      try {
        request.cancel();
      } catch {
        // _getConnection can also be inspected before its request is sent.
      }
    });
    requests.clear();
    destroy();
  };
  return provider;
}

export async function findEnsForRefresh(
  address: string,
  timeoutMs: number
): Promise<EnsLookupResult> {
  // Construct outside the catch so missing configuration still fails visibly.
  const provider = createEnsRefreshProvider(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<EnsLookupResult>((resolve) => {
      timer = setTimeout(() => {
        provider.destroy();
        resolve({ status: 'unavailable' });
      }, timeoutMs);
    });
    const result = await Promise.race([
      // Promise.race installs rejection handlers on every input, including after
      // timeout. The destroyed provider rejects any subsequent transport work.
      lookupPrimaryEnsNameResult(address, provider),
      timeout
    ]);
    return result.status === 'resolved' && result.name
      ? { status: 'resolved', name: text.replaceEmojisWithHex(result.name) }
      : result;
  } finally {
    clearTimeout(timer);
    provider.destroy();
  }
}
