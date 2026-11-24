import { withArweaveFallback } from '@/arweave-gateway-fallback';
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

async function fetchTextAttempt(
  url: string,
  opts: FetchOptions,
  signal?: AbortSignal
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
  const cancelAttempt = () =>
    cancel(budget?.signal.aborted ? 'resolution_budget' : 'request_timeout');
  signal?.addEventListener('abort', cancelAttempt, { once: true });
  if (signal?.aborted) cancelAttempt();
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
    signal?.removeEventListener('abort', cancelAttempt);
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

async function fetchAndValidate<T>(
  url: string,
  opts: FetchOptions,
  validate: (body: string) => T
): Promise<T> {
  const budget = getNftLinkResolutionBudget();
  return withArweaveFallback(
    url,
    async (candidate, signal) =>
      validate(await fetchTextAttempt(candidate, opts, signal)),
    {
      signal: budget?.signal,
      timeoutMs: Math.min(
        opts.timeoutMs * 4,
        budget?.remainingMs() ?? Number.MAX_SAFE_INTEGER
      ),
      // The transport's own timer supplies the existing typed timeout first.
      attemptTimeoutMs: opts.timeoutMs + 50
    }
  );
}

export async function fetchTextWithTimeout(
  url: string,
  opts: FetchOptions
): Promise<string> {
  return fetchAndValidate(url, opts, (body) => body);
}

export async function fetchJsonWithTimeout<T>(
  url: string,
  opts: FetchOptions
): Promise<T> {
  return fetchAndValidate(
    url,
    { ...opts, headers: { accept: 'application/json', ...opts.headers } },
    (body) => {
      const value: unknown = JSON.parse(body);
      if (value === null || typeof value !== 'object')
        throw new Error('Invalid metadata JSON');
      return value as T;
    }
  );
}
