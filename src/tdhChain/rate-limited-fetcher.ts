import { createHash } from 'crypto';

/**
 * GETs one at a time, at least `minIntervalMs` apart (500 ms: at most two
 * requests a second), to hosts on an allow list, with no credentials: no
 * cookies, no Authorization header, a generic User-Agent. Redirects are
 * followed by hand, so each hop is checked against the list. A 429 or 5xx is
 * retried a few times; every attempt counts against the rate.
 */

export interface FetchedBody {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly sha256: string;
}

export interface RequestLogEntry {
  readonly url: string;
  readonly status: number;
  readonly bytes: number;
  readonly sha256: string | null;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface RateLimitedFetcherOptions {
  /** Hosts allowed, exactly or as a parent domain (`arweave.net`). */
  readonly allowedHosts: readonly string[];
  /** Hosts that may be reached over plain http (a devnet gateway). */
  readonly httpHosts?: readonly string[];
  readonly minIntervalMs?: number;
  readonly retries?: number;
  readonly userAgent?: string;
  /** Each attempt's time limit; the day's CSV files are tens of MB. */
  readonly timeoutMs?: number;
  readonly fetchFn?: FetchFn;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class FetchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchRefusedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const MAX_REDIRECTS = 5;

export class RateLimitedFetcher {
  private readonly minIntervalMs: number;
  private readonly retries: number;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastStart = -Infinity;
  private queue: Promise<unknown> = Promise.resolve();
  readonly log: RequestLogEntry[] = [];

  constructor(private readonly options: RateLimitedFetcherOptions) {
    this.minIntervalMs = options.minIntervalMs ?? 500;
    this.retries = options.retries ?? 3;
    this.userAgent = options.userAgent ?? 'tdh-chain-compare/1';
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.fetchFn =
      options.fetchFn ?? ((url, init) => fetch(url, init) as Promise<Response>);
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private checkUrl(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new FetchRefusedError(`${raw} is not a URL`);
    }
    const httpAllowed = (this.options.httpHosts ?? []).includes(
      url.hostname.toLowerCase()
    );
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && httpAllowed)
    ) {
      throw new FetchRefusedError(`${raw} is not https`);
    }
    if (url.username || url.password) {
      throw new FetchRefusedError(`${raw} carries credentials`);
    }
    const host = url.hostname.toLowerCase();
    const allowed = this.options.allowedHosts.some(
      (a) => host === a || host.endsWith(`.${a}`)
    );
    if (!allowed)
      throw new FetchRefusedError(`${host} is not on the allow list`);
    return url;
  }

  private async paced(url: string, jsonBody?: string): Promise<Response> {
    const wait = this.lastStart + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastStart = this.now();
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept: '*/*'
    };
    if (jsonBody !== undefined) headers['Content-Type'] = 'application/json';
    return this.fetchFn(url, {
      method: jsonBody === undefined ? 'GET' : 'POST',
      body: jsonBody,
      redirect: 'manual',
      credentials: 'omit',
      headers,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
  }

  /**
   * What the log keeps of a URL. A POST goes to an RPC endpoint whose path
   * can carry a provider key, so only its origin is kept.
   */
  private logged(url: string, jsonBody?: string): string {
    return jsonBody === undefined ? url : new URL(url).origin;
  }

  private async requestOnce(
    raw: string,
    jsonBody?: string
  ): Promise<FetchedBody> {
    let current = this.checkUrl(raw).toString();
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let attempt = 0;
      let res = await this.paced(current, jsonBody);
      while (
        (res.status === 429 || res.status >= 500) &&
        attempt < this.retries
      ) {
        this.log.push({
          url: this.logged(current, jsonBody),
          status: res.status,
          bytes: 0,
          sha256: null
        });
        attempt++;
        await this.sleep(1000 * attempt);
        res = await this.paced(current, jsonBody);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        this.log.push({
          url: this.logged(current, jsonBody),
          status: res.status,
          bytes: 0,
          sha256: null
        });
        if (!location)
          throw new FetchRefusedError(
            `${current}: redirect without a location`
          );
        current = this.checkUrl(
          new URL(location, current).toString()
        ).toString();
        continue;
      }
      const body = new Uint8Array(await res.arrayBuffer());
      const sha256 = createHash('sha256').update(body).digest('hex');
      this.log.push({
        url: this.logged(current, jsonBody),
        status: res.status,
        bytes: body.length,
        sha256
      });
      return {
        url: current,
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body,
        sha256
      };
    }
    throw new FetchRefusedError(`${raw}: more than ${MAX_REDIRECTS} redirects`);
  }

  private enqueue(run: () => Promise<FetchedBody>): Promise<FetchedBody> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** One GET, queued behind the requests before it. */
  get(url: string): Promise<FetchedBody> {
    return this.enqueue(() => this.requestOnce(url));
  }

  /** One JSON POST (an Ethereum JSON-RPC read), paced like a GET. */
  postJson(url: string, body: unknown): Promise<FetchedBody> {
    return this.enqueue(() => this.requestOnce(url, JSON.stringify(body)));
  }
}

export function bodyText(fetched: FetchedBody): string {
  return Buffer.from(fetched.body).toString('utf8');
}

export function bodyJson(fetched: FetchedBody): any {
  if (fetched.status !== 200) {
    throw new Error(`${fetched.url}: HTTP ${fetched.status}`);
  }
  return JSON.parse(bodyText(fetched));
}
