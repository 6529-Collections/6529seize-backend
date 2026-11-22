import fetch from 'node-fetch';

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export type HttpGet = (url: string) => Promise<HttpResponse>;

export interface PublicApiClientOptions {
  /** The API base, for example `https://<api host>/api`. No credentials. */
  readonly baseUrl: string;
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

/**
 * GET with redirects followed here, so a protocol-relative Location (as file
 * gateways send) resolves against the request URL and stays on https.
 */
async function defaultHttpGet(url: string): Promise<HttpResponse> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: {
        accept: '*/*',
        'user-agent': 'subscriptions-parity'
      }
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, current);
      if (
        next.protocol !== 'https:' &&
        next.protocol !== new URL(current).protocol
      ) {
        throw new Error(`Refusing a redirect to ${next.protocol}`);
      }
      current = next.toString();
      continue;
    }
    return { status: response.status, body: await response.text() };
  }
  throw new Error(`Too many redirects from ${url}`);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Unauthenticated GETs against the public API, one at a time and never
 * faster than one start per `minIntervalMs`. Sends no cookies and no
 * authorization header. Retries 429 and 5xx with doubling waits.
 */
export class PublicApiClient {
  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly httpGet: HttpGet;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastStartMs = Number.NEGATIVE_INFINITY;
  private queue: Promise<unknown> = Promise.resolve();
  private requests = 0;

  constructor(options: PublicApiClientOptions) {
    if (!/^https?:\/\//.test(options.baseUrl)) {
      throw new Error('The API base must be an http(s) URL');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
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

  /** Text from an absolute URL (a published list file). */
  async getText(url: string): Promise<string> {
    if (!/^https:\/\//.test(url)) {
      throw new Error(`Refusing a non-https file URL: ${url}`);
    }
    return (await this.get(url, [])).body;
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
      await this.waitForSlot();
      this.requests++;
      const response = await this.httpGet(url);
      if (response.status === 200 || nullOn.includes(response.status)) {
        return response;
      }
      if (!isRetryable(response.status) || attempt >= this.maxRetries) {
        throw new Error(`GET ${url} answered ${response.status}`);
      }
      await this.sleep(this.minIntervalMs * 2 ** (attempt + 1));
    }
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
