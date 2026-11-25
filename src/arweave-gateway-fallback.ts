import {
  ARWEAVE_INPUT_GATEWAYS,
  ARWEAVE_READ_GATEWAYS
} from '@/arweave/gateways';
import { recoverArweave, ArweaveRecoveryOptions } from '@/arweave/recovery';
import {
  parseDecentralizedMediaRef,
  toExternalFallbackUrls
} from '@/decentralized-media/decentralized-media';

const pathGateways = new Set<string>(ARWEAVE_INPUT_GATEWAYS);

function rawGatewayRef(input: string) {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || !pathGateways.has(url.hostname))
      return null;
    if (!/^\/raw\/[A-Za-z0-9_-]{43}(?=\/|$)/.test(url.pathname)) return null;
    url.pathname = url.pathname.slice(4);
    return parseDecentralizedMediaRef(url.href);
  } catch {
    return null;
  }
}

/**
 * Returns all external Arweave gateway variants for the given URL.
 */
export function getArweaveFallbackUrls(url: string): string[] {
  const raw = rawGatewayRef(url);
  const ref = raw ?? parseDecentralizedMediaRef(url);
  if (ref?.protocol !== 'arweave') return [];
  // Raw retrieval must bypass manifest resolution. Only offer the documented
  // path-style raw endpoint; transaction subdomains have different path semantics.
  if (raw)
    return ARWEAVE_READ_GATEWAYS.map((host) => `https://${host}/raw/${ref.id}`);
  return toExternalFallbackUrls(ref);
}

/**
 * Returns the next Arweave gateway URL after the current URL.
 * If the current URL is not itself one of the external fallbacks, returns the
 * first external fallback.
 */
export function getArweaveFallbackUrl(url: string): string | null {
  const urls = getArweaveFallbackUrls(url);
  if (urls.length < 1) return null;

  const currentIndex = urls.indexOf(stripQueryAndHash(url));
  if (currentIndex < 0) return urls[0] ?? null;
  if (currentIndex >= urls.length - 1) return null;

  return urls[currentIndex + 1] ?? null;
}

function stripQueryAndHash(url: string): string {
  const queryIndex = url.indexOf('?');
  const hashIndex = url.indexOf('#');
  const indexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  if (indexes.length === 0) return url;

  return url.slice(0, Math.min(...indexes));
}

/** Complete the response/body validation inside fetchFn so failures advance gateways. */
export async function withArweaveFallback<T>(
  url: string,
  fetchFn: (url: string, signal: AbortSignal) => Promise<T>,
  options: ArweaveRecoveryOptions = {}
): Promise<T> {
  const urls = getArweaveFallbackUrls(url);
  if (!urls.length) {
    // Unrelated URLs retain their caller's transport and timeout policy.
    return fetchFn(url, options.signal ?? new AbortController().signal);
  }
  return recoverArweave(
    /^https?:\/\//i.test(url) ? [url, ...urls] : urls,
    fetchFn,
    options
  );
}
