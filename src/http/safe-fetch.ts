import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import fetch, {
  RequestInit as NodeFetchRequestInit,
  Response
} from 'node-fetch';

export type SafeFetchOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MiB
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
  // 0.0.0.0/8
  if (masked(0xff000000) === 0x00000000) return true;
  // 100.64.0.0/10 (carrier-grade NAT)
  if (masked(0xffc00000) === 0x64400000) return true;
  // 10.0.0.0/8
  if (masked(0xff000000) === 0x0a000000) return true;
  // 127.0.0.0/8
  if (masked(0xff000000) === 0x7f000000) return true;
  // 169.254.0.0/16 (link-local, incl. AWS metadata)
  if (masked(0xffff0000) === 0xa9fe0000) return true;
  // 172.16.0.0/12
  if (masked(0xfff00000) === 0xac100000) return true;
  // 192.168.0.0/16
  if (masked(0xffff0000) === 0xc0a80000) return true;
  // 192.0.0.0/24 (IETF protocol assignments)
  if (masked(0xffffff00) === 0xc0000000) return true;
  // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (TEST-NET ranges)
  if (masked(0xffffff00) === 0xc0000200) return true;
  if (masked(0xffffff00) === 0xc6336400) return true;
  if (masked(0xffffff00) === 0xcb007100) return true;
  // 198.18.0.0/15 (benchmarking)
  if (masked(0xfffe0000) === 0xc6120000) return true;
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved
  if (masked(0xf0000000) === 0xe0000000) return true;
  if (masked(0xf0000000) === 0xf0000000) return true;
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fe80:')) return true; // link-local
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // unique local
  // IPv4-mapped IPv6 ::ffff:a.b.c.d or ::ffff:7f00:1
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
  if (h === 'localhost' || h === 'localhost.' || h.endsWith('.localhost'))
    return true;
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
  const literalIp = parsed.hostname;
  if (isIP(literalIp)) {
    if (isPrivateIp(literalIp)) {
      throw new Error(`Forbidden IP address: ${literalIp}`);
    }
  }
  return parsed;
}

async function assertHostnameResolvesToPublicIps(hostname: string) {
  if (isIP(hostname)) {
    // already validated in parse step
    return;
  }
  const results = await lookup(hostname, { all: true });
  if (!results.length) {
    throw new Error(`DNS lookup returned no results for ${hostname}`);
  }
  for (const r of results) {
    if (isPrivateIp(r.address)) {
      throw new Error(`DNS resolved to forbidden IP for ${hostname}`);
    }
  }
}

async function readResponseToBufferOrThrow(
  res: Response,
  maxBytes: number
): Promise<Buffer> {
  const contentLength = res.headers.get('content-length');
  if (contentLength) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(`Response too large: ${n} bytes`);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const body = res.body as any;
  if (!body) return Buffer.alloc(0);
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      try {
        body.destroy?.();
      } catch {
        // ignore
      }
      throw new Error(`Response exceeded max size of ${maxBytes} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function contentTypeFromResponse(res: Response): string | null {
  const raw = res.headers.get('content-type');
  if (!raw) return null;
  return raw.split(';')[0]?.trim() || null;
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

  // Validate the initial hostname (and each redirect target) before fetching.
  await assertHostnameResolvesToPublicIps(currentUrl.hostname);

  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();

    let res: Response;
    try {
      const init: NodeFetchRequestInit = {
        method: 'GET',
        redirect: 'manual',
        headers: options.headers,
        signal: controller.signal as any
      };
      res = await fetch(currentUrl.toString(), init);
    } finally {
      clearTimeout(timeout);
    }

    if (
      res.status === 301 ||
      res.status === 302 ||
      res.status === 303 ||
      res.status === 307 ||
      res.status === 308
    ) {
      if (redirectsRemaining <= 0) {
        throw new Error(`Too many redirects fetching ${url}`);
      }
      const location = res.headers.get('location');
      if (!location) {
        throw new Error(`Redirect without location fetching ${url}`);
      }
      const next = new URL(location, currentUrl);
      currentUrl = parseAndValidatePublicHttpUrl(next.toString());
      await assertHostnameResolvesToPublicIps(currentUrl.hostname);
      redirectsRemaining--;
      continue;
    }

    if (!res.ok) {
      throw new Error(`Fetch failed: ${res.status} ${currentUrl.toString()}`);
    }

    const buffer = await readResponseToBufferOrThrow(res, maxBytes);
    return {
      buffer,
      contentType: contentTypeFromResponse(res),
      finalUrl: currentUrl.toString()
    };
  }
}
