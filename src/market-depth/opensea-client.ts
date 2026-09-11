import { randomInt } from 'node:crypto';
import {
  OpenSeaDeadlineError,
  OpenSeaRateLimiter
} from '@/market-depth/opensea-rate-limiter';
export { OpenSeaDeadlineError } from '@/market-depth/opensea-rate-limiter';

const API_BASE = 'https://api.opensea.io/api/v2';
const PAGE_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 15_000;
// Limit decoded bytes as well as Content-Length (which may describe compressed data).
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET'
]);

export interface OpenSeaPage<T> {
  readonly entries: T[];
  readonly next: string | null;
}

export interface OpenSeaClientOptions {
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly baseUrl?: string;
}

export class OpenSeaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number,
    message: string
  ) {
    super(message);
    Object.setPrototypeOf(this, OpenSeaHttpError.prototype);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function retryAfter(response: Response, now: number): number {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function parsePage<T>(raw: unknown, key: string): OpenSeaPage<T> {
  const page = asRecord(raw);
  if (!Array.isArray(page[key])) throw new Error(`Invalid OpenSea ${key} page`);
  if (page.next != null && typeof page.next !== 'string') {
    throw new Error(`Invalid OpenSea ${key} cursor`);
  }
  return {
    entries: page[key] as T[],
    next: (page.next as string | null) || null
  };
}

interface JsonParseContext {
  readonly source?: string;
}

const parseJsonWithSource = JSON.parse as unknown as (
  source: string,
  reviver: (key: string, value: unknown, context: JsonParseContext) => unknown
) => unknown;

/** Preserve unsafe numeric lexemes without making unrelated metadata abort a page. */
export function parseOpenSeaJson(source: string): unknown {
  return parseJsonWithSource(source, (_key, value, context) => {
    if (
      typeof value === 'number' &&
      (!Number.isFinite(value) ||
        (Number.isInteger(value) &&
          (!Number.isSafeInteger(value) ||
            (context?.source !== undefined &&
              !/^-?\d+$/.test(context.source)))))
    ) {
      // Fractions can round to unsafe integers, too. Preserve the literal rather
      // than a rounded value; the normalizer accepts only canonical integers.
      if (context?.source) return context.source;
      throw new Error(
        'OpenSea JSON contains a number that cannot be preserved'
      );
    }
    return value;
  });
}

async function readResponseBody(response: Response): Promise<string> {
  const declaredBytes = Number(response.headers.get('content-length'));
  if (declaredBytes > MAX_RESPONSE_BYTES) {
    throw new Error('OpenSea response exceeds the size limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let complete = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        return Buffer.concat(chunks, bytes).toString('utf8');
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new Error('OpenSea response exceeds the size limit');
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    // Cleanup must not hold the request open if a transport cancellation stalls.
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function collectionSlug(raw: Record<string, unknown>): string | null {
  const collection = asRecord(raw.collection);
  if (typeof collection.collection === 'string') return collection.collection;
  if (typeof raw.collection === 'string') return raw.collection;
  if (typeof collection.slug === 'string') return collection.slug;
  return null;
}

function providerResetAt(reset: number, now: number): number {
  if (reset > 10_000_000_000) return reset;
  if (reset > now / 1000) return reset * 1000;
  return now + reset * 1000;
}

function isTransientNetworkError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const details = current as { code?: unknown; cause?: unknown };
    if (
      typeof details.code === 'string' &&
      RETRYABLE_NETWORK_CODES.has(details.code)
    ) {
      return true;
    }
    current = details.cause;
  }
  return error instanceof TypeError;
}

function isRetryable(error: unknown): boolean {
  return (
    (error instanceof OpenSeaHttpError && RETRYABLE.has(error.status)) ||
    (error instanceof Error && error.name === 'AbortError') ||
    isTransientNetworkError(error)
  );
}

export class OpenSeaClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly rateLimiter: OpenSeaRateLimiter;
  private providerBlockedUntil = 0;

  constructor(options: OpenSeaClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENSEA_API_KEY ?? '';
    if (!this.apiKey) throw new Error('OPENSEA_API_KEY is required');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
    this.rateLimiter = new OpenSeaRateLimiter({
      sleep: this.sleep,
      now: this.now
    });
    if (options.baseUrl && process.env.NODE_ENV !== 'test') {
      throw new Error('OpenSea base URL overrides are only allowed in tests');
    }
    this.baseUrl = (options.baseUrl ?? API_BASE).replace(/\/$/, '');
  }

  async getAllListings(
    collectionSlug: string,
    deadlineMs = this.now() + DEFAULT_DEADLINE_MS
  ): Promise<unknown[]> {
    return this.allPages(
      `/listings/collection/${encodeURIComponent(collectionSlug)}/all`,
      'listings',
      { include_private_listings: 'true' },
      deadlineMs
    );
  }

  async getAllOffers(
    collectionSlug: string,
    deadlineMs = this.now() + DEFAULT_DEADLINE_MS
  ): Promise<unknown[]> {
    return this.allPages(
      `/offers/collection/${encodeURIComponent(collectionSlug)}/all`,
      'offers',
      {},
      deadlineMs
    );
  }

  async getEventsPage(
    collectionSlug: string,
    after: number,
    before: number,
    cursor: string | null,
    deadlineMs = this.now() + DEFAULT_DEADLINE_MS
  ): Promise<OpenSeaPage<unknown>> {
    const raw = await this.getJson(
      `/events/collection/${encodeURIComponent(collectionSlug)}`,
      {
        after: String(after),
        before: String(before),
        limit: String(PAGE_LIMIT),
        ...(cursor ? { next: cursor } : {})
      },
      deadlineMs
    );
    return parsePage(raw, 'asset_events');
  }

  async getNftCollection(
    contract: string,
    tokenId: string,
    deadlineMs = this.now() + DEFAULT_DEADLINE_MS
  ): Promise<string> {
    const raw = asRecord(
      await this.getJson(
        `/chain/ethereum/contract/${encodeURIComponent(contract)}/nfts/${encodeURIComponent(tokenId)}/collection`,
        {},
        deadlineMs
      )
    );
    const slug = collectionSlug(raw);
    if (!slug) throw new Error('OpenSea NFT collection response has no slug');
    return slug;
  }

  async getOrder(
    chain: string,
    protocol: string,
    orderHash: string,
    deadlineMs = this.now() + DEFAULT_DEADLINE_MS
  ): Promise<unknown> {
    return this.getJson(
      `/orders/chain/${encodeURIComponent(chain)}/protocol/${encodeURIComponent(protocol)}/${encodeURIComponent(orderHash)}`,
      {},
      deadlineMs
    );
  }

  private async allPages(
    path: string,
    key: string,
    initial: Record<string, string>,
    deadlineMs: number
  ): Promise<unknown[]> {
    const entries: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const raw = await this.getJson(
        path,
        {
          limit: String(PAGE_LIMIT),
          ...initial,
          ...(cursor ? { next: cursor } : {})
        },
        deadlineMs
      );
      const page = parsePage<unknown>(raw, key);
      entries.push(...page.entries);
      cursor = page.next;
      if (cursor) {
        if (seen.has(cursor)) throw new Error(`Repeated OpenSea ${key} cursor`);
        seen.add(cursor);
      }
    } while (cursor);
    return entries;
  }

  private updateProviderLimit(response: Response): void {
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (!Number.isFinite(remaining) || !Number.isFinite(reset) || remaining > 0)
      return;
    const resetMs = providerResetAt(reset, this.now());
    this.providerBlockedUntil = Math.max(this.providerBlockedUntil, resetMs);
  }

  private async acquireRequestBudget(deadlineMs: number): Promise<number> {
    const providerWait = Math.max(0, this.providerBlockedUntil - this.now());
    if (this.now() + providerWait >= deadlineMs)
      throw new OpenSeaDeadlineError('OpenSea request deadline exceeded');
    if (providerWait > 0) await this.sleep(providerWait);
    await this.rateLimiter.acquire(deadlineMs);
    const remaining = deadlineMs - this.now();
    if (remaining <= 0)
      throw new OpenSeaDeadlineError('OpenSea request deadline exceeded');
    return remaining;
  }

  private async requestJson(url: URL, remaining: number): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(REQUEST_TIMEOUT_MS, remaining)
    );
    let response: Response | undefined;
    try {
      response = await this.fetchImpl(url, {
        headers: { 'x-api-key': this.apiKey },
        signal: controller.signal
      });
      this.updateProviderLimit(response);
      if (!response.ok) {
        throw new OpenSeaHttpError(
          response.status,
          retryAfter(response, this.now()),
          `OpenSea HTTP ${response.status}`
        );
      }
      return parseOpenSeaJson(await readResponseBody(response));
    } finally {
      clearTimeout(timeout);
      controller.abort();
      if (response?.body && !response.bodyUsed) {
        void response.body.cancel().catch(() => undefined);
      }
    }
  }

  private async waitForRetry(
    error: unknown,
    attempt: number,
    deadlineMs: number
  ): Promise<void> {
    if (!isRetryable(error) || attempt === MAX_ATTEMPTS) throw error;
    const serverWait =
      error instanceof OpenSeaHttpError ? error.retryAfterMs : 0;
    const backoff = Math.min(30_000, 500 * 2 ** (attempt - 1));
    const wait = Math.max(serverWait, backoff + randomInt(backoff));
    // A provider/network failure remains a failure even when its retry cannot
    // fit. Only waiting for an unused request budget is a planned deferral.
    if (this.now() + wait >= deadlineMs) throw error;
    await this.sleep(wait);
  }

  private async getJson(
    path: string,
    query: Record<string, string>,
    deadlineMs: number
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    let retryError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let remaining: number;
      try {
        remaining = await this.acquireRequestBudget(deadlineMs);
      } catch (error) {
        throw retryError ?? error;
      }
      try {
        return await this.requestJson(url, remaining);
      } catch (error) {
        retryError = error;
        await this.waitForRetry(error, attempt, deadlineMs);
      }
    }
    throw new Error('OpenSea request failed');
  }
}
