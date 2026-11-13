import { env } from '@/env';
import {
  openPublicResponse,
  OpenedPublicResponse,
  readPublicResponseBody
} from '@/http/public-fetch';
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

export class NftLinkHttpTimeoutError extends Error {
  constructor() {
    super('NFT link HTTP request timed out');
    Object.setPrototypeOf(this, NftLinkHttpTimeoutError.prototype);
    this.name = 'NftLinkHttpTimeoutError';
  }
}

const DEFAULT_USER_AGENT = '6529-link-resolver/0.7';
const MAX_REDIRECTS = 5;
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
  let opened: OpenedPublicResponse | undefined;
  try {
    // Public HTTPS only; every redirect hop is re-validated and pinned.
    opened = await openPublicResponse(url, {
      method: 'GET',
      headers: {
        'user-agent': DEFAULT_USER_AGENT,
        ...opts.headers
      },
      maxRedirects: MAX_REDIRECTS,
      httpsOnly: true,
      signal: controller.signal
    });
    const res = opened.response;
    status = res.status;
    if (!res.ok) {
      throw new HttpError(
        res.status,
        url,
        `HTTP ${res.status} for ${url}`,
        opened.finalUrl
      );
    }

    const body = await readPublicResponseBody(res, {
      maxBytes: getMaxBytes(opts),
      signal: controller.signal
    });
    outcome = 'success';
    return body.toString('utf8');
  } catch (error) {
    // Only the bounded refresher opts in. Preserve other HTTP callers' errors.
    if (budget && cancellation === 'request_timeout')
      throw new NftLinkHttpTimeoutError();
    if (budget && cancellation === 'resolution_budget') budget.check();
    throw error;
  } finally {
    clearTimeout(t);
    opened?.cancel();
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
