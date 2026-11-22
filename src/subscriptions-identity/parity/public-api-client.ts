import fetch from 'node-fetch';

export interface HttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
  /** The Location header of a redirect, as sent. */
  readonly location?: string | null;
}

/** One request, redirects not followed. */
export type HttpGet = (request: HttpRequest) => Promise<HttpResponse>;

export interface PublicApiClientOptions {
  /** The API base, https only, for example `https://<api host>/api`. */
  readonly baseUrl: string;
  /**
   * Hosts list files may be read from (and their subdomains). The API host
   * is always allowed.
   */
  readonly fileHosts?: readonly string[];
  /** At least this long between request starts. 500 ms is 2 a second. */
  readonly minIntervalMs?: number;
  readonly maxRetries?: number;
  readonly httpGet?: HttpGet;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_MIN_INTERVAL_MS = 500;
const DEFAULT_MAX_RETRIES = 4;
const MAX_REDIRECTS = 5;
/** The gateway that serves the published list files. */
const DEFAULT_FILE_HOSTS = ['arweave.net'];

/**
 * Sent on every request: no authorization, no cookie. Some file gateways
 * answer a redirect without a Location when JSON is preferred, so any type
 * is accepted.
 */
export const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  accept: '*/*',
  'user-agent': 'subscriptions-parity'
};

async function defaultHttpGet(request: HttpRequest): Promise<HttpResponse> {
  const response = await fetch(request.url, {
    redirect: 'manual',
    headers: { ...request.headers }
  });
  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400) {
    return { status: response.status, body: '', location };
  }
  return { status: response.status, body: await response.text() };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function isRedirect(response: HttpResponse): boolean {
  return response.status >= 300 && response.status < 400;
}

/**
 * Unauthenticated GETs against the public API and the list-file gateway,
 * one at a time and never faster than one start per `minIntervalMs`,
 * redirect hops included. Only https, and only the API host and the file
 * hosts. Retries 429 and 5xx with doubling waits.
 */
export class PublicApiClient {
  private readonly baseUrl: string;
  private readonly apiHost: string;
  private readonly fileHosts: readonly string[];
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly httpGet: HttpGet;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastStartMs = Number.NEGATIVE_INFINITY;
  private queue: Promise<unknown> = Promise.resolve();
  private requests = 0;

  constructor(options: PublicApiClientOptions) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== 'https:') {
      throw new Error('The API base must be an https URL');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiHost = base.host.toLowerCase();
    this.fileHosts = (options.fileHosts ?? DEFAULT_FILE_HOSTS).map((h) =>
      h.toLowerCase()
    );
    this.minIntervalMs = Math.max(
      options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      DEFAULT_MIN_INTERVAL_MS
    );
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.httpGet = options.httpGet ?? defaultHttpGet;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
  }

  get requestCount(): number {
    return this.requests;
  }

  url(
    path: string,
    query: Record<string, string | number | undefined> = {}
  ): string {
    const params = Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(
        ([name, value]) =>
          `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`
      )
      .join('&');
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${suffix}${params ? `?${params}` : ''}`;
  }

  /** JSON from an API path; null on 404 or another listed status. */
  async getJson<T>(
    path: string,
    query: Record<string, string | number | undefined> = {},
    nullOn: readonly number[] = [404]
  ): Promise<T | null> {
    const response = await this.get(this.url(path, query), nullOn);
    if (response.status !== 200) {
      return null;
    }
    return JSON.parse(response.body) as T;
  }

  /** Text from an absolute URL on the API host or a file host. */
  async getText(url: string): Promise<string> {
    return (await this.get(url, [])).body;
  }

  private assertAllowed(url: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new Error(`Refusing a non-https URL: ${url}`);
    }
    const host = parsed.host.toLowerCase();
    const allowed =
      host === this.apiHost ||
      this.fileHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!allowed) {
      throw new Error(`Refusing a host outside the allow-list: ${host}`);
    }
  }

  private get(url: string, nullOn: readonly number[]): Promise<HttpResponse> {
    const run = this.queue.then(() => this.getWithRetries(url, nullOn));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async getWithRetries(
    url: string,
    nullOn: readonly number[]
  ): Promise<HttpResponse> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.getFollowingRedirects(url);
      if (response.status === 200 || nullOn.includes(response.status)) {
        return response;
      }
      if (!isRetryable(response.status) || attempt >= this.maxRetries) {
        throw new Error(`GET ${url} answered ${response.status}`);
      }
      await this.sleep(this.minIntervalMs * 2 ** (attempt + 1));
    }
  }

  private async getFollowingRedirects(url: string): Promise<HttpResponse> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      this.assertAllowed(current);
      await this.waitForSlot();
      this.requests++;
      const response = await this.httpGet({
        url: current,
        headers: REQUEST_HEADERS
      });
      if (!isRedirect(response) || !response.location) {
        return response;
      }
      current = new URL(response.location, current).toString();
    }
    throw new Error(`Too many redirects from ${url}`);
  }

  private async waitForSlot(): Promise<void> {
    const wait = this.lastStartMs + this.minIntervalMs - this.now();
    if (wait > 0) {
      await this.sleep(wait);
    }
    this.lastStartMs = this.now();
  }
}

export interface PaginatedPage<T> {
  readonly count: number;
  readonly page: number;
  readonly next: string | null;
  readonly data: T[];
}

/** Every page of a paginated route, in order. */
export async function fetchAllPages<T>(
  client: PublicApiClient,
  path: string,
  query: Record<string, string | number | undefined>,
  pageSize: number,
  stop?: (page: T[]) => boolean
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const result = await client.getJson<PaginatedPage<T>>(path, {
      ...query,
      page_size: pageSize,
      page
    });
    const data = result?.data ?? [];
    rows.push(...data);
    if (data.length < pageSize || !result?.next || stop?.(data)) {
      return rows;
    }
  }
}
