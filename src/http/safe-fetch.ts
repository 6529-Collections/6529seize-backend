import { promises as dnsPromises } from 'dns';
import { isIP } from 'node:net';
import type { RequestInit as NodeFetchRequestInit, Response } from 'node-fetch';
import fetch from 'node-fetch';

export type SafeFetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

function parseIpv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (
    ((nums[0] << 24) + (nums[1] << 16) + (nums[2] << 8) + (nums[3] << 0)) >>> 0
  );
}

function isPrivateIpv4(ip: string): boolean {
  const n = parseIpv4ToInt(ip);
  if (n == null) return true;
  const masked = (mask: number) => (n & mask) >>> 0;
  if (masked(0xff000000) === 0x00000000) return true;
  if (masked(0xffc00000) === 0x64400000) return true;
  if (masked(0xff000000) === 0x0a000000) return true;
  if (masked(0xff000000) === 0x7f000000) return true;
  if (masked(0xffff0000) === 0xa9fe0000) return true;
  if (masked(0xfff00000) === 0xac100000) return true;
  if (masked(0xffff0000) === 0xc0a80000) return true;
  if (masked(0xffffff00) === 0xc0000000) return true;
  if (masked(0xffffff00) === 0xc0000200) return true;
  if (masked(0xffffff00) === 0xc6336400) return true;
  if (masked(0xffffff00) === 0xcb007100) return true;
  if (masked(0xfffe0000) === 0xc6120000) return true;
  if (masked(0xf0000000) === 0xe0000000) return true;
  if (masked(0xf0000000) === 0xf0000000) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fe80:')) return true;
  if (s.startsWith('fc') || s.startsWith('fd')) return true;
  const dotted = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) {
    return isPrivateIp(dotted[1]);
  }
  const hexMapped = s.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped?.[1] && hexMapped?.[2]) {
    const hi = Number.parseInt(hexMapped[1], 16);
    const lo = Number.parseInt(hexMapped[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      const ipv4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      return isPrivateIp(ipv4);
    }
  }
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true;
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
  if (isIP(parsed.hostname) && isPrivateIp(parsed.hostname)) {
    throw new Error(`Forbidden IP address: ${parsed.hostname}`);
  }
  return parsed;
}

async function assertHostnameResolvesToPublicIps(hostname: string) {
  if (isIP(hostname)) return;
  const results = await dnsPromises.lookup(hostname, { all: true });
  if (results.length === 0) {
    throw new Error(`DNS lookup returned no results for ${hostname}`);
  }
  for (const result of results) {
    if (isPrivateIp(result.address)) {
      throw new Error(`DNS resolved to forbidden IP for ${hostname}`);
    }
  }
}

async function readResponseToBufferOrThrow(
  response: Response,
  maxBytes: number
): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const size = Number(contentLength);
    if (Number.isFinite(size) && size > maxBytes) {
      throw new Error(`Response too large: ${size} bytes`);
    }
  }

  const body = response.body;
  if (!body) return Buffer.alloc(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  const stream = body as AsyncIterable<unknown> & { destroy?: () => void };
  for await (const chunk of stream) {
    let asChunk: Uint8Array;
    if (typeof chunk === 'string') {
      asChunk = new Uint8Array(Buffer.from(chunk, 'utf8'));
    } else if (Buffer.isBuffer(chunk)) {
      asChunk = new Uint8Array(chunk);
    } else if (chunk instanceof Uint8Array) {
      asChunk = chunk;
    } else if (chunk instanceof ArrayBuffer) {
      asChunk = new Uint8Array(chunk);
    } else {
      asChunk = new Uint8Array(Buffer.from(String(chunk), 'utf8'));
    }
    total += asChunk.byteLength;
    if (total > maxBytes) {
      stream.destroy?.();
      throw new Error(`Response exceeded max size of ${maxBytes} bytes`);
    }
    chunks.push(asChunk);
  }

  const buffer = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

function contentTypeFromResponse(response: Response): string | null {
  const contentType = response.headers.get('content-type');
  if (!contentType) return null;
  return contentType.split(';')[0]?.trim() || null;
}

export async function fetchPublicUrlToBuffer(
  url: string,
  options: SafeFetchOptions = {}
): Promise<{ buffer: Buffer; contentType: string | null; finalUrl: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let currentUrl = parseAndValidatePublicHttpUrl(url);
  let redirectsRemaining = maxRedirects;
  await assertHostnameResolvesToPublicIps(currentUrl.hostname);

  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();

    let response: Response;
    try {
      const init: NodeFetchRequestInit = {
        method: 'GET',
        redirect: 'manual',
        headers: options.headers,
        signal: controller.signal as never
      };
      response = await fetch(currentUrl.toString(), init);
    } catch (err) {
      if (err instanceof Error) {
        if (
          err.name === 'AbortError' ||
          (err as { type?: string }).type === 'request-timeout'
        ) {
          throw new Error(
            `Fetch timed out after ${timeoutMs}ms: ${currentUrl.toString()}`
          );
        }
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (
      response.status === 301 ||
      response.status === 302 ||
      response.status === 303 ||
      response.status === 307 ||
      response.status === 308
    ) {
      if (redirectsRemaining <= 0) {
        throw new Error(`Too many redirects fetching ${url}`);
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Redirect without location fetching ${url}`);
      }
      const next = new URL(location, currentUrl);
      currentUrl = parseAndValidatePublicHttpUrl(next.toString());
      await assertHostnameResolvesToPublicIps(currentUrl.hostname);
      redirectsRemaining--;
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `Fetch failed: ${response.status} ${currentUrl.toString()}`
      );
    }

    return {
      buffer: await readResponseToBufferOrThrow(response, maxBytes),
      contentType: contentTypeFromResponse(response),
      finalUrl: currentUrl.toString()
    };
  }
}
