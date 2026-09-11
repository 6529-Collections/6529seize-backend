import { FetchRequest, JsonRpcProvider, type FetchGetUrlFunc } from 'ethers';
import fetch from 'node-fetch';
import type { AbortSignal as NodeFetchAbortSignal } from 'node-fetch/externals';
import { env } from '@/env';
import {
  NftLinkResolutionBudget,
  NFT_LINK_RPC_TIMEOUT_MS,
  nftLinkResolutionStage
} from '@/nft-links/resolution-budget';

const providers = new WeakMap<NftLinkResolutionBudget, JsonRpcProvider>();

export function getResolutionRpcProvider(
  budget: NftLinkResolutionBudget
): JsonRpcProvider {
  budget.check();
  const existing = providers.get(budget);
  if (existing) return existing;

  const request = new FetchRequest(env.getStringOrThrow('NFT_INDEXER_RPC'));
  request.timeout = NFT_LINK_RPC_TIMEOUT_MS;
  // The resolver owns retries; don't hide throttle delays inside ethers.
  request.retryFunc = async () => false;
  request.getUrlFunc = createResolutionRpcTransport(budget);
  const provider = new JsonRpcProvider(request, undefined, {
    batchMaxCount: 1
  });
  const destroy = () => provider.destroy();
  budget.signal.addEventListener('abort', destroy, { once: true });
  budget.addCleanup(() => {
    budget.signal.removeEventListener('abort', destroy);
    provider.destroy();
  });
  providers.set(budget, provider);
  return provider;
}

/** Abort the socket and response body, including during DNS/connection stalls. */
export function createResolutionRpcTransport(
  budget: NftLinkResolutionBudget
): FetchGetUrlFunc {
  return async (request, signal) => {
    budget.check();
    signal?.checkSignal();
    const controller = new AbortController();
    const abort = () => controller.abort();
    budget.signal.addEventListener('abort', abort, { once: true });
    signal?.addListener(abort);
    const timer = setTimeout(
      abort,
      Math.min(request.timeout, budget.remainingMs())
    );
    try {
      return await nftLinkResolutionStage('rpc', async () => {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body ? Buffer.from(request.body) : undefined,
          redirect: 'manual',
          size: 2_000_000,
          signal: controller.signal as unknown as NodeFetchAbortSignal
        });
        // Ethers redirects create a new request without this bounded transport.
        // RPC endpoints must respond directly; the resolver owns all retries.
        if (response.status < 200 || response.status >= 300) {
          throw new Error('RPC HTTP request failed');
        }
        return {
          statusCode: response.status,
          statusMessage: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: new Uint8Array(await response.arrayBuffer())
        };
      });
    } catch {
      // RPC URLs can contain provider credentials. Never pass transport errors
      // (which include the full URL) into persistence, logs, or Sentry.
      const error = new Error(
        controller.signal.aborted
          ? 'NFT link RPC request timed out or cancelled'
          : 'NFT link RPC transport failed'
      );
      if (controller.signal.aborted) error.name = 'AbortError';
      throw error;
    } finally {
      clearTimeout(timer);
      // Close unread error bodies as well as requests cancelled by the deadline.
      controller.abort();
      budget.signal.removeEventListener('abort', abort);
    }
  };
}
