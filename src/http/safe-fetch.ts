import { isIP } from 'node:net';
import { publicFetch, PublicFetchTimeoutError } from '@/http/public-fetch';
import { isPublicIpAddress } from '@/http/public-network-address';

export type SafeFetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

export function isPrivateIp(ip: string): boolean {
  return !isPublicIpAddress(ip);
}

export function isForbiddenHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  if (h === 'localhost' || h === 'localhost.' || h.endsWith('.localhost')) {
    return true;
  }
  return false;
}

export function parseAndValidatePublicHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs with credentials are not allowed');
  }
  if (!parsed.hostname) {
    throw new Error('URL hostname is required');
  }
  if (isForbiddenHostname(parsed.hostname)) {
    throw new Error(`Forbidden hostname: ${parsed.hostname}`);
  }
  const literal = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) && isPrivateIp(literal)) {
    throw new Error(`Forbidden IP address: ${parsed.hostname}`);
  }
  return parsed;
}

/**
 * Overall deadline for one fetch, as a multiple of the caller's per-hop
 * timeout: one budget for reaching the final response headers and one for
 * reading the body. A response that stalls mid-body is therefore cut off at
 * twice the caller's timeout instead of running until the runtime limit.
 */
export const OVERALL_DEADLINE_TIMEOUT_MULTIPLIER = 2;

/**
 * Fetches a public http(s) URL into memory. Every hop's DNS answers are
 * validated and the validated address is the one the connection uses.
 * `timeoutMs` bounds each hop until response headers arrive, and the whole
 * fetch including the body read is bounded by
 * `timeoutMs * OVERALL_DEADLINE_TIMEOUT_MULTIPLIER`.
 */
export async function fetchPublicUrlToBuffer(
  url: string,
  options: SafeFetchOptions = {}
): Promise<{ buffer: Buffer; contentType: string | null; finalUrl: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  parseAndValidatePublicHttpUrl(url);
  let result;
  try {
    result = await publicFetch(url, {
      method: 'GET',
      headers: options.headers,
      maxBytes,
      maxRedirects,
      requestTimeoutMs: timeoutMs,
      timeoutMs: timeoutMs * OVERALL_DEADLINE_TIMEOUT_MULTIPLIER
    });
  } catch (err) {
    if (err instanceof PublicFetchTimeoutError) {
      throw new Error(`Fetch timed out after ${err.timeoutMs}ms: ${url}`);
    }
    if (
      err instanceof Error &&
      (err.name === 'AbortError' ||
        (err as { type?: string }).type === 'request-timeout')
    ) {
      throw new Error(`Fetch timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  }
  if (!result.ok) {
    throw new Error(`Fetch failed: ${result.status} ${result.finalUrl}`);
  }
  const contentType = result.headers.get('content-type');
  return {
    buffer: result.body,
    contentType: contentType?.split(';')[0]?.trim() || null,
    finalUrl: result.finalUrl
  };
}
