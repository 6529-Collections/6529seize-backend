import fetch, { Response } from 'node-fetch';
import type { AbortSignal as NodeFetchAbortSignal } from 'node-fetch/externals';
import { numbers } from '@/numbers';
import { env } from '@/env';
import { getNftLinkResolutionBudget } from '@/nft-links/resolution-budget';
import { Logger } from '@/logging';

export class HttpError extends Error {
  public readonly responseMatchesRequest: boolean;
  public readonly responseMatchesTransientWwwAlias: boolean;
  constructor(
    public readonly status: number,
    public readonly url: string,
    message: string,
    responseUrl?: string
  ) {
    super(message);
    Object.setPrototypeOf(this, HttpError.prototype);
    this.responseMatchesRequest = responseUrl === url;
    // Retain only identity evidence, never an arbitrary final redirect URL.
    // The provider's HTTPS www alias must keep the exact path and query.
    const transientOrigin = 'https://transient.xyz';
    this.responseMatchesTransientWwwAlias =
      url.startsWith(`${transientOrigin}/`) &&
      !url.includes('#') &&
      responseUrl ===
        `https://www.transient.xyz${url.slice(transientOrigin.length)}`;
  }
}

export interface FetchOptions {
  timeoutMs: number;
  headers?: Record<string, string>;
  maxBytes?: number;
  diagnosticPurpose?: 'superrare_metadata';
}

const DEFAULT_USER_AGENT = '6529-link-resolver/0.7';
const logger = Logger.get('NFT_LINK_HTTP');

function diagnosticHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

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
  const budget = getNftLinkResolutionBudget();
  budget?.check();
  const controller = new AbortController();
  const startedAt = Date.now();
  let cancellation: 'request_timeout' | 'resolution_budget' | null = null;
  let status: number | null = null;
  let outcome: 'success' | 'failure' = 'failure';
  const cancel = (source: NonNullable<typeof cancellation>) => {
    cancellation ??= source;
    controller.abort();
  };
  const abort = () => cancel('resolution_budget');
  budget?.signal.addEventListener('abort', abort, { once: true });
  const t = setTimeout(() => cancel('request_timeout'), opts.timeoutMs);
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
    status = res.status;
    if (!res.ok) {
      throw new HttpError(
        res.status,
        url,
        `HTTP ${res.status} for ${url}`,
        res.url
      );
    }

    const text = await readTextWithLimit(res, url, getMaxBytes(opts));
    outcome = 'success';
    return text;
  } finally {
    clearTimeout(t);
    if (budget) controller.abort();
    budget?.signal.removeEventListener('abort', abort);
    if (opts.diagnosticPurpose) {
      // One line, no URL path/query/credentials or error payload. Preserve the
      // original exception and the caller's existing operational alert policy.
      logger.info(
        JSON.stringify({
          event: 'http_fetch_finished',
          purpose: opts.diagnosticPurpose,
          hostname: diagnosticHostname(url),
          timeout_ms: opts.timeoutMs,
          elapsed_ms: Date.now() - startedAt,
          status,
          outcome,
          cancellation
        })
      );
    }
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
