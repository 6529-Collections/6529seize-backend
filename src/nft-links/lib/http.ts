import fetch, { Response } from 'node-fetch';
import type { AbortSignal as NodeFetchAbortSignal } from 'node-fetch/externals';
import { numbers } from '@/numbers';
import { env } from '@/env';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message: string
  ) {
    super(message);
  }
}

export interface FetchOptions {
  timeoutMs: number;
  headers?: Record<string, string>;
  maxBytes?: number;
}

const DEFAULT_USER_AGENT = '6529-link-resolver/0.7';

function getMaxBytes(opts: FetchOptions): number {
  const envMax = env.getIntOrNull('LINK_RESOLVER_HTTP_MAX_BYTES');
  return opts.maxBytes ?? ((envMax ?? 0) > 0 ? envMax! : 2_000_000);
}

async function readTextWithLimit(
  res: Response,
  url: string,
  maxBytes: number
): Promise<string> {
  const contentLength = res.headers.get('content-length');
  if (contentLength) {
    const n = numbers.parseIntOrNull(contentLength) ?? 0;
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(`Response too large (${n} bytes) for ${url}`);
    }
  }

  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.length > maxBytes) {
    throw new Error(`Response too large (${buf.length} bytes) for ${url}`);
  }
  return buf.toString('utf8');
}

export async function fetchTextWithTimeout(
  url: string,
  opts: FetchOptions
): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'user-agent': DEFAULT_USER_AGENT,
        ...opts.headers
      },
      // node-fetch v2 uses its own AbortSignal type definition.
      signal: controller.signal as unknown as NodeFetchAbortSignal
    });
    if (!res.ok) {
      throw new HttpError(res.status, url, `HTTP ${res.status} for ${url}`);
    }

    return await readTextWithLimit(res, url, getMaxBytes(opts));
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJsonWithTimeout<T>(
  url: string,
  opts: FetchOptions
): Promise<T> {
  const txt = await fetchTextWithTimeout(url, {
    ...opts,
    headers: { accept: 'application/json', ...opts.headers }
  });
  return JSON.parse(txt) as T;
}
