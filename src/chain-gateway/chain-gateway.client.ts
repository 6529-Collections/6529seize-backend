import { createHash, randomInt } from 'node:crypto';
import { Logger } from '@/logging';
import {
  ChainAnswer,
  ChainDelegation,
  ChainDelegationQuery,
  ChainDraft,
  ChainDraftRequest,
  ChainFeedCursor,
  ChainFeedPage,
  ChainHandle,
  ChainHead,
  ChainIdentity,
  ChainImportedIdentity,
  ChainLevel,
  ChainMembershipDay,
  ChainMembershipDayWallets,
  ChainMembershipWallet,
  ChainPage,
  ChainPageOptions,
  ChainRating,
  ChainRatingMatter,
  ChainRatingTotal,
  ChainReadOptions,
  ChainReadStamp,
  ChainStatus,
  ChainStoredDoc,
  ChainSubmitRequest,
  ChainSubmitResult,
  ChainTdhQuery,
  ChainTx,
  ChainWalletDelegations,
  ChainWalletHistory
} from './chain-gateway.types';

/**
 * The one client 6529.io's backend uses to read the 6529 chain and to relay
 * signed operations to it, through 6529's chain gateway (service access).
 *
 * - Reads are pinned to a height. Without `opts.height` the client pins the
 *   latest finalized height it knows (refreshed every `headTtlMs`), so the
 *   reads of one task agree; pinned answers never change and are cached in
 *   memory by (path, query, height). `opts.at = 'head'` reads the
 *   unfinalized head, uncached.
 * - Retries network errors, timeouts, 429 and 5xx with backoff (honouring
 *   Retry-After). 404 is `null`. Other refusals throw ChainGatewayError
 *   carrying the API's code (`height_gone`, `inadmissible`, ...).
 * - Documents are fetched by CID from the gateway's document store and
 *   checked against their CID; those up to a profile document's size are
 *   cached.
 *
 * Settings (environment or the shared secret): CHAIN_GATEWAY_URL (required at
 * first use), CHAIN_GATEWAY_SERVICE_KEY (the service bearer key),
 * CHAIN_GATEWAY_TIMEOUT_MS, CHAIN_GATEWAY_RETRIES, CHAIN_GATEWAY_HEAD_TTL_MS,
 * CHAIN_GATEWAY_CACHE_ENTRIES.
 */

const logger = Logger.get('CHAIN_GATEWAY');

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    /** JSON text, or bytes for a document upload. */
    body?: string | Uint8Array;
    signal?: AbortSignal;
  }
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface ChainGatewayConfig {
  readonly baseUrl: string;
  readonly serviceKey: string | null;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly headTtlMs: number;
  readonly cacheEntries: number;
  readonly fetchImpl?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export class ChainGatewayError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
    readonly path: string
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ChainGatewayError';
  }
}

function intOr(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n >= 0
    ? n
    : fallback;
}

export function chainGatewayConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): ChainGatewayConfig {
  const baseUrl = env.CHAIN_GATEWAY_URL?.trim();
  if (!baseUrl) {
    throw new ChainGatewayError(
      'CHAIN_GATEWAY_URL is not set',
      null,
      'not_configured',
      ''
    );
  }
  return {
    baseUrl: trimTrailingSlashes(baseUrl),
    serviceKey: env.CHAIN_GATEWAY_SERVICE_KEY?.trim() || null,
    timeoutMs: intOr(env.CHAIN_GATEWAY_TIMEOUT_MS, 10_000),
    retries: intOr(env.CHAIN_GATEWAY_RETRIES, 3),
    headTtlMs: intOr(env.CHAIN_GATEWAY_HEAD_TTL_MS, 2_000),
    cacheEntries: intOr(env.CHAIN_GATEWAY_CACHE_ENTRIES, 10_000)
  };
}

/**
 * Least recently used entries go first: past `capacity` entries, or past
 * `maxWeight` in total when entries are weighed (documents by their bytes).
 */
export class LruCache<V> {
  private readonly map = new Map<string, V>();
  private weight = 0;

  constructor(
    private readonly capacity: number,
    private readonly weigh: (value: V) => number = () => 0,
    private readonly maxWeight = Number.POSITIVE_INFINITY
  ) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.remove(key);
    if (this.capacity <= 0 || this.weigh(value) > this.maxWeight) return;
    this.map.set(key, value);
    this.weight += this.weigh(value);
    while (this.map.size > this.capacity || this.weight > this.maxWeight) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }

  private remove(key: string) {
    const value = this.map.get(key);
    if (value === undefined) return;
    this.weight -= this.weigh(value);
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
    this.weight = 0;
  }
}

/** Cached documents take at most this many bytes in all. */
const DOC_CACHE_TOTAL_BYTES = 32 * 1024 * 1024;
/**
 * A profile document's largest size (524,288 bytes, the ProfileDoc.v1
 * limit): larger documents, such as profile site files, are not cached.
 */
const DOC_CACHE_ENTRY_BYTES = 524_288;
/** CIDv1, codec raw (0x55), multihash sha2-256 (0x12) of 32 bytes. */
const RAW_SHA256_CID_PREFIX = [0x01, 0x55, 0x12, 0x20];

type Query = Record<string, string | number | boolean | null | undefined>;

interface Envelope<T> {
  readonly read?: ChainReadStamp;
  readonly data?: T;
  readonly next?: string | number | null;
  /** The node answers `{ code, message }`; the gateway's proxy a string. */
  readonly error?:
    | { readonly code?: string; readonly message?: string }
    | string;
  readonly message?: string;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

type RetryableError = ChainGatewayError & { retryAfterMs?: number };

function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}
const RFC4648_LOWER = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of Array.from(bytes)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += RFC4648_LOWER[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += RFC4648_LOWER[(value << (5 - bits)) & 31];
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.toLowerCase().replace(/^0x/, '');
  if (!/^([0-9a-f]{2})*$/.test(clean)) {
    throw new ChainGatewayError(`Not hex: ${hex}`, null, 'bad_request', '');
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'));
}

/** A CID as the document store names it: multibase base32 (`b...`). */
export function cidPath(cid: string): string {
  return `b${base32(hexToBytes(cid))}`;
}

/**
 * A CID's bytes as `0x` hex, from hex or from base32 text (`b...`, as the
 * document store and profile documents write it). Throws on anything else.
 */
export function cidHex(cid: string): string {
  const text = cid.trim();
  // A CIDv1 in hex starts with its version byte, 01; base32 text with `b`.
  if (/^(0x)?0[0-9a-f]*$/i.test(text)) {
    const bytes = hexToBytes(text);
    if (bytes.length < 4) {
      throw new ChainGatewayError(`Not a CID: ${cid}`, null, 'bad_request', '');
    }
    return '0x' + Buffer.from(bytes).toString('hex');
  }
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text.startsWith('b') ? text.slice(1) : '') {
    const index = RFC4648_LOWER.indexOf(char);
    if (index < 0) break;
    value = ((value << 5) | index) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const hex = '0x' + Buffer.from(bytes).toString('hex');
  if (bytes.length < 4 || cidPath(hex) !== text) {
    throw new ChainGatewayError(`Not a CID: ${cid}`, null, 'bad_request', '');
  }
  return hex;
}

/** The raw sha2-256 CIDv1 of some bytes, as `0x` hex. */
export function rawCidHexOf(bytes: Uint8Array): string {
  return (
    '0x' +
    Buffer.concat([
      Buffer.from(RAW_SHA256_CID_PREFIX),
      createHash('sha256').update(bytes).digest()
    ]).toString('hex')
  );
}

/** An answer the client can't read (the gateway's, not the caller's fault). */
function badAnswer(path: string, what: string): ChainGatewayError {
  return new ChainGatewayError(`${path}: ${what}`, 200, 'bad_answer', path);
}

/** The CID the document store answered with, as hex; bad_answer if unreadable. */
function storedCidHex(cid: string, path: string): string {
  try {
    return cidHex(cid);
  } catch {
    throw badAnswer(path, `the store answered with a CID that can't be read`);
  }
}

/** The sha2-256 digest a CIDv1 names (any codec), or null for another CID. */
function sha256DigestOf(cid: Uint8Array): Buffer | null {
  if (cid[0] !== 0x01) return null;
  // The codec is an unsigned varint.
  let i = 1;
  while (i < cid.length && (cid[i] & 0x80) !== 0) i++;
  i++; // past the codec's last byte
  const isSha256 =
    cid.length === i + 34 && cid[i] === 0x12 && cid[i + 1] === 0x20;
  return isSha256 ? Buffer.from(cid.slice(i + 2)) : null;
}

/**
 * Whether the bytes are the content a CIDv1 with a sha2-256 multihash names,
 * whatever its codec. False for any other CID: its content can't be checked.
 */
export function bytesMatchCid(cid: string, bytes: Uint8Array): boolean {
  const digest = sha256DigestOf(hexToBytes(cid));
  return (
    digest !== null &&
    createHash('sha256').update(bytes).digest().equals(digest)
  );
}

/**
 * A wallet's binding changes, strictly: each a whole height, ascending, and
 * a principal id or null. Anything else throws, because a misread change
 * could read as "bound to none".
 */
function bindingChanges(
  value: unknown,
  path: string
): { height: number; principalId: string | null }[] {
  if (!Array.isArray(value)) {
    throw badAnswer(path, `no binding changes in the answer`);
  }
  let previous = -1;
  const changes: unknown[] = value;
  return changes.map((entry) => {
    const it = entry as { height?: unknown; principalId?: unknown } | null;
    const height = typeof it?.height === 'number' ? it.height : Number.NaN;
    const principal = it?.principalId;
    const principalOk =
      principal === null ||
      (typeof principal === 'string' && /^0x[0-9a-f]{64}$/i.test(principal));
    if (!Number.isSafeInteger(height) || height <= previous || !principalOk) {
      throw badAnswer(path, `a binding change that can't be read`);
    }
    previous = height;
    return {
      height,
      principalId: principal === null ? null : lower(principal)
    };
  });
}

/** The height a feed cursor (a height, or `height:index`) starts in. */
export function feedCursorHeight(cursor: ChainFeedCursor): number {
  return Number(String(cursor).split(':')[0]);
}

/**
 * The feed's held height ranges, `[[from, to], ...]` of whole heights;
 * absent is none, anything else throws (a misread range could make a
 * history look complete).
 */
function heightRanges(value: unknown, path: string): [number, number][] {
  if (value === undefined || value === null) return [];
  const ranges = Array.isArray(value) ? value : [null];
  return ranges.map((it: unknown) => {
    const [from, to] = Array.isArray(it) && it.length === 2 ? it : [];
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      (from as number) < 0 ||
      (to as number) < (from as number)
    ) {
      throw badAnswer(path, `a height range that can't be read`);
    }
    return [from as number, to as number];
  });
}

function lower(address: string): string {
  return address.trim().toLowerCase();
}

function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

export class ChainGatewayClient {
  private resolved: ChainGatewayConfig | null = null;
  private head: { value: ChainHead; at: number } | null = null;
  private headInFlight: Promise<ChainHead> | null = null;
  private caches: {
    readonly answers: LruCache<ChainAnswer<unknown> | null>;
    readonly docs: LruCache<Buffer>;
  } | null = null;

  constructor(
    private readonly configSupplier: () => ChainGatewayConfig = () =>
      chainGatewayConfigFromEnv()
  ) {}

  private config(): ChainGatewayConfig {
    if (!this.resolved) {
      const resolved = this.configSupplier();
      this.caches = {
        answers: new LruCache(resolved.cacheEntries),
        docs: new LruCache<Buffer>(
          Math.max(1, Math.floor(resolved.cacheEntries / 4)),
          (doc) => doc.length,
          DOC_CACHE_TOTAL_BYTES
        )
      };
      this.resolved = resolved;
    }
    return this.resolved;
  }

  private get answers(): LruCache<ChainAnswer<unknown> | null> {
    this.config();
    return this.caches!.answers;
  }

  private get docs(): LruCache<Buffer> {
    this.config();
    return this.caches!.docs;
  }

  private now(): number {
    return (this.config().now ?? Date.now)();
  }

  /** Drops the cached head and answers (tests, or after a long pause). */
  clearCache(): void {
    this.head = null;
    this.caches?.answers.clear();
    this.caches?.docs.clear();
  }

  // ---------------------------------------------------------------- transport

  private url(path: string, query: Query = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'boolean') {
        if (value) params.append(key, '1');
        continue;
      }
      params.append(key, String(value));
    }
    const search = params.toString();
    const suffix = search ? '?' + search : '';
    return `${this.config().baseUrl}${path}${suffix}`;
  }

  private headersFor(binary: boolean, body: unknown) {
    const headers: Record<string, string> = {
      accept: binary ? 'application/octet-stream' : 'application/json',
      'user-agent': '6529-backend'
    };
    const key = this.config().serviceKey;
    if (key) {
      headers.authorization = `Bearer ${key}`;
    }
    if (body instanceof Uint8Array) {
      headers['content-type'] = 'application/octet-stream';
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    return headers;
  }

  /** Bytes go as they are (document uploads); anything else as JSON. */
  private encodeBody(body: unknown): string | Uint8Array | undefined {
    if (body === undefined || body instanceof Uint8Array) {
      return body;
    }
    return JSON.stringify(body);
  }

  /**
   * One attempt: the answer, or a ChainGatewayError marked retryable for a
   * network error, a timeout, 429 or 5xx.
   */
  private async attempt(
    method: 'GET' | 'POST',
    path: string,
    url: string,
    body: unknown,
    binary: boolean
  ): Promise<
    | {
        ok: true;
        status: number;
        json: Envelope<unknown> | null;
        bytes?: Buffer;
      }
    | { ok: false; error: RetryableError }
  > {
    const config = this.config();
    const fetchImpl: FetchLike =
      config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: this.headersFor(binary, body),
        body: this.encodeBody(body),
        signal: controller.signal
      });
      if (RETRYABLE.has(response.status)) {
        const error = this.errorOf(
          path,
          response.status,
          await this.parse(response)
        );
        return {
          ok: false,
          error: Object.assign(error, {
            retryAfterMs: this.retryAfterMs(response.headers.get('retry-after'))
          })
        };
      }
      if (binary && response.status === 200) {
        const bytes = Buffer.from(await response.arrayBuffer());
        return { ok: true, status: 200, json: null, bytes };
      }
      return {
        ok: true,
        status: response.status,
        json: await this.parse(response)
      };
    } catch (error) {
      if (error instanceof ChainGatewayError) {
        throw error;
      }
      const reason = (error as Error)?.message ?? String(error);
      const code = controller.signal.aborted ? 'timeout' : 'network';
      return {
        ok: false,
        error: new ChainGatewayError(
          `${method} ${path} failed: ${reason}`,
          null,
          code,
          path
        )
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    query: Query,
    body?: unknown,
    binary = false
  ): Promise<{
    status: number;
    json: Envelope<unknown> | null;
    bytes?: Buffer;
  }> {
    const config = this.config();
    const sleep =
      config.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const url = this.url(path, query);
    let lastError: RetryableError = new ChainGatewayError(
      `${method} ${path} was not attempted`,
      null,
      'network',
      path
    );
    for (let attempt = 0; attempt <= config.retries; attempt++) {
      if (attempt > 0) {
        await sleep(this.backoff(attempt, lastError));
      }
      const result = await this.attempt(method, path, url, body, binary);
      if (result.ok) {
        return result;
      }
      lastError = result.error;
    }
    logger.warn(
      `[GATEWAY ${method} ${path} GAVE UP] [${lastError.code}] [${lastError.message}]`
    );
    throw lastError;
  }

  private backoff(attempt: number, error: RetryableError): number {
    if (error.retryAfterMs !== undefined) {
      return Math.min(error.retryAfterMs, 10_000);
    }
    const base = Math.min(5_000, 200 * 2 ** (attempt - 1));
    // Jitter only spreads retries out; it needs no secure randomness, but
    // randomInt keeps one generator in the file.
    return base + randomInt(100);
  }

  private retryAfterMs(header: string | null): number | undefined {
    if (!header) return undefined;
    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds >= 0
      ? Math.round(seconds * 1000)
      : undefined;
  }

  private async parse(response: {
    text(): Promise<string>;
  }): Promise<Envelope<unknown> | null> {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as Envelope<unknown>;
    } catch {
      return { error: { code: 'bad_answer', message: text.slice(0, 200) } };
    }
  }

  private errorOf(
    path: string,
    status: number,
    json: Envelope<unknown> | null
  ): ChainGatewayError {
    const error = json?.error;
    const code =
      (typeof error === 'string' ? error : error?.code) ?? `http_${status}`;
    const message =
      (typeof error === 'string' ? json?.message : error?.message) ??
      `HTTP ${status}`;
    return new ChainGatewayError(
      `${path}: ${code}: ${message}`,
      status,
      code,
      path
    );
  }

  private toAnswer<T>(
    path: string,
    status: number,
    json: Envelope<unknown> | null
  ): ChainAnswer<T> | null {
    if (status === 404) {
      return null;
    }
    if (status !== 200 || !json || json.error || !json.read) {
      throw this.errorOf(path, status, json);
    }
    const next =
      json.next === undefined || json.next === null ? null : String(json.next);
    return { read: json.read, data: json.data as T, next };
  }

  // ---------------------------------------------------------------- reads

  /** The head and finalized heights, cached for `headTtlMs`. */
  async getHead(force = false): Promise<ChainHead> {
    const config = this.config();
    if (!force && this.head && this.now() - this.head.at < config.headTtlMs) {
      return this.head.value;
    }
    if (!this.headInFlight) {
      this.headInFlight = (async () => {
        try {
          const status = await this.getStatus();
          const value: ChainHead = {
            headHeight: status.head.height,
            finalizedHeight: status.finalized.height,
            finalizedTime: status.finalized.time,
            pinnable: status.pinnable ?? null,
            network: status.finalized.network ?? null
          };
          // Answers are cached by height: from another chain (a relaunch)
          // the same heights mean other blocks.
          const before = this.head?.value.network ?? null;
          if (before && value.network && before !== value.network) {
            this.caches?.answers.clear();
          }
          this.head = { value, at: this.now() };
          return value;
        } finally {
          this.headInFlight = null;
        }
      })();
    }
    return await this.headInFlight;
  }

  async getStatus(): Promise<ChainStatus> {
    const path = '/v1/status';
    const { status, json } = await this.send('GET', path, {});
    if (status !== 200 || !json?.data) {
      throw this.errorOf(path, status, json);
    }
    return json.data as ChainStatus;
  }

  /**
   * Any read route: the answer, or null for 404. Pinned as the class says.
   * Use the typed methods below where one exists.
   */
  async read<T>(
    path: string,
    query: Query = {},
    opts: ChainReadOptions = {}
  ): Promise<ChainAnswer<T> | null> {
    if (opts.at === 'head') {
      const { status, json } = await this.send('GET', path, {
        ...query,
        at: 'head'
      });
      return this.toAnswer<T>(path, status, json);
    }
    if (opts.height !== undefined) {
      return await this.pinnedRead<T>(path, query, opts.height);
    }
    const head = await this.getHead();
    try {
      return await this.pinnedRead<T>(path, query, head.finalizedHeight);
    } catch (error) {
      if (
        !(error instanceof ChainGatewayError) ||
        error.code !== 'height_gone'
      ) {
        throw error;
      }
    }
    // The gateway answered from a node that doesn't hold that height (yet):
    // re-pin once, then read unpinned.
    const fresh = await this.getHead(true);
    try {
      return await this.pinnedRead<T>(path, query, fresh.finalizedHeight);
    } catch (error) {
      if (
        !(error instanceof ChainGatewayError) ||
        error.code !== 'height_gone'
      ) {
        throw error;
      }
    }
    const { status, json } = await this.send('GET', path, query);
    return this.toAnswer<T>(path, status, json);
  }

  private async pinnedRead<T>(
    path: string,
    query: Query,
    height: number
  ): Promise<ChainAnswer<T> | null> {
    const key = this.url(path, { ...query, height });
    const cached = this.answers.get(key);
    if (cached !== undefined) {
      return cached as ChainAnswer<T> | null;
    }
    const { status, json } = await this.send('GET', path, { ...query, height });
    const answer = this.toAnswer<T>(path, status, json);
    this.answers.set(key, answer as ChainAnswer<unknown> | null);
    return answer;
  }

  private async data<T>(
    path: string,
    query: Query = {},
    opts: ChainReadOptions = {}
  ): Promise<T | null> {
    return (await this.read<T>(path, query, opts))?.data ?? null;
  }

  private async page<T>(
    path: string,
    query: Query,
    opts: ChainPageOptions,
    items: (data: unknown) => T[] = (data) =>
      Array.isArray(data) ? (data as T[]) : []
  ): Promise<ChainPage<T> | null> {
    const answer = await this.read<unknown>(
      path,
      { ...query, after: opts.after ?? undefined, limit: opts.limit },
      opts
    );
    if (!answer) return null;
    return { items: items(answer.data), next: answer.next, read: answer.read };
  }

  // Identities

  getIdentityByPrincipal(principalId: string, opts?: ChainReadOptions) {
    return this.data<ChainIdentity>(
      `/v1/identities/${segment(lower(principalId))}`,
      {},
      opts
    );
  }

  getIdentityByHandle(handle: string, opts?: ChainReadOptions) {
    return this.data<ChainIdentity>(
      `/v1/identities/by-handle/${segment(handle.trim().toLowerCase())}`,
      {},
      opts
    );
  }

  getIdentityByWallet(wallet: string, opts?: ChainReadOptions) {
    return this.data<ChainIdentity>(
      `/v1/identities/by-wallet/${segment(lower(wallet))}`,
      {},
      opts
    );
  }

  /**
   * The import file's entry the identity was created from (its legacy id
   * and the ProfileDoc the import wrote), or null when the import didn't
   * create it.
   */
  getImportedIdentity(principalId: string, opts?: ChainReadOptions) {
    return this.data<ChainImportedIdentity>(
      `/v1/identities/${segment(lower(principalId))}/imported`,
      {},
      opts
    );
  }

  /** The identity a 6529.io profile id (UUID) was imported to. */
  getIdentityByLegacyProfileId(profileId: string, opts?: ChainReadOptions) {
    return this.data<ChainIdentity>(
      `/v1/identities/by-legacy/${segment(lower(profileId))}`,
      {},
      opts
    );
  }

  /** Wallet to identity (null: unbound), 100 wallets a call, one height. */
  async getIdentitiesByWallets(
    wallets: string[],
    opts: ChainReadOptions = {}
  ): Promise<Record<string, ChainIdentity | null>> {
    const distinct = Array.from(new Set(wallets.map(lower)));
    const result: Record<string, ChainIdentity | null> = {};
    if (!distinct.length) return result;
    const pinned: ChainReadOptions =
      opts.at === 'head' || opts.height !== undefined
        ? opts
        : { height: (await this.getHead()).finalizedHeight };
    for (let i = 0; i < distinct.length; i += 100) {
      const chunk = distinct.slice(i, i + 100);
      const data = await this.data<Record<string, ChainIdentity | null>>(
        '/v1/identities/by-wallets',
        { wallets: chunk.join(',') },
        pinned
      );
      for (const wallet of chunk) {
        result[wallet] = data?.[wallet] ?? null;
      }
    }
    return result;
  }

  listIdentities(opts: ChainPageOptions = {}) {
    return this.page<ChainIdentity>('/v1/identities', {}, opts);
  }

  getLevel(principalId: string, opts?: ChainReadOptions) {
    return this.data<ChainLevel>(
      `/v1/levels/${segment(lower(principalId))}`,
      {},
      opts
    );
  }

  getHandle(handle: string, opts?: ChainReadOptions) {
    return this.data<ChainHandle>(
      `/v1/handles/${segment(handle.trim().toLowerCase())}`,
      {},
      opts
    );
  }

  // Membership

  getMembership(opts?: ChainReadOptions) {
    return this.data<Record<string, unknown>>('/v1/membership', {}, opts);
  }

  getMembershipWallet(wallet: string, opts?: ChainReadOptions) {
    return this.data<ChainMembershipWallet>(
      `/v1/membership/wallets/${segment(lower(wallet))}`,
      {},
      opts
    );
  }

  /**
   * Every binding change of a wallet the gateway's feed holds, the height
   * ranges it is exact within, and the height of the read.
   */
  async getMembershipWalletHistory(
    wallet: string,
    opts?: ChainReadOptions
  ): Promise<ChainWalletHistory | null> {
    const path = `/v1/membership/wallets/${segment(lower(wallet))}/history`;
    const answer = await this.read<{
      wallet?: string;
      changes?: unknown;
      ranges?: unknown;
    }>(path, {}, opts);
    if (!answer?.data) return null;
    const readHeight = answer.read?.height;
    if (
      lower(answer.data.wallet ?? '') !== lower(wallet) ||
      !Number.isSafeInteger(readHeight)
    ) {
      throw badAnswer(
        path,
        `the answer is for another wallet or has no read height`
      );
    }
    return {
      wallet: lower(wallet),
      changes: bindingChanges(answer.data.changes, path),
      ranges: heightRanges(answer.data.ranges, path),
      readHeight
    };
  }

  listMembershipWallets(opts: ChainPageOptions = {}) {
    return this.page<ChainMembershipWallet>('/v1/membership/wallets', {}, opts);
  }

  /** TDH day `day`'s membership record (and the node's saved copy). */
  getMembershipDay(day: number, opts?: ChainReadOptions) {
    return this.data<ChainMembershipDay>(
      `/v1/membership/days/${segment(day)}`,
      {},
      opts
    );
  }

  /** Every wallet's principal at day `day`'s cutoff height, by wallet. */
  listMembershipDayWallets(day: number, opts: ChainPageOptions = {}) {
    return this.page<ChainMembershipDayWallets['wallets'][number]>(
      `/v1/membership/days/${segment(day)}/wallets`,
      {},
      opts,
      (data) => (data as ChainMembershipDayWallets | null)?.wallets ?? []
    );
  }

  // Delegations

  getDelegations(query: ChainDelegationQuery, opts: ChainPageOptions = {}) {
    let path: string;
    if ('holder' in query) {
      path = `/v1/delegations/by-holder/${segment(lower(query.holder))}`;
    } else if ('byDelegate' in query) {
      path = `/v1/delegations/by-delegate/${segment(lower(query.byDelegate))}`;
    } else if ('byCollection' in query) {
      path = `/v1/delegations/by-collection/${segment(lower(query.byCollection))}`;
    } else {
      path = `/v1/delegations/by-use-case/${segment(query.byUseCase)}`;
    }
    return this.page<ChainDelegation>(
      path,
      {
        useCase: query.useCase,
        collection: query.collection ? lower(query.collection) : undefined,
        delegate: query.delegate ? lower(query.delegate) : undefined,
        live: query.live
      },
      opts
    );
  }

  /** The wallet's own records and its identity's (when bound). */
  getDelegationsOfWallet(wallet: string, opts?: ChainReadOptions) {
    return this.data<ChainWalletDelegations[]>(
      `/v1/delegations/of-wallet/${segment(lower(wallet))}`,
      {},
      opts
    );
  }

  // Ratings

  getRatings(
    query:
      | { readonly target: string; readonly matter?: ChainRatingMatter }
      | { readonly rater: string; readonly matter?: ChainRatingMatter },
    opts: ChainPageOptions = {}
  ) {
    const path =
      'target' in query
        ? `/v1/ratings/by-target/${segment(lower(query.target))}`
        : `/v1/ratings/by-rater/${segment(lower(query.rater))}`;
    return this.page<ChainRating>(path, { matter: query.matter }, opts);
  }

  getRatingTotals(principalId: string, opts?: ChainReadOptions) {
    return this.data<ChainRatingTotal[]>(
      `/v1/ratings/totals/${segment(lower(principalId))}`,
      {},
      opts
    );
  }

  // TDH (the TDH loop types the answers)

  getTdh<T = Record<string, unknown>>(
    query: ChainTdhQuery = {},
    opts: ChainPageOptions = {}
  ): Promise<ChainAnswer<T> | null> {
    let path = '/v1/tdh';
    if (query.wallet) {
      path = `/v1/tdh/wallets/${segment(lower(query.wallet))}`;
    } else if (query.day !== undefined) {
      const list = query.list ? '/' + query.list : '';
      path = `/v1/tdh/days/${segment(query.day)}${list}`;
    }
    return this.read<T>(
      path,
      query.list ? { after: opts.after ?? undefined, limit: opts.limit } : {},
      opts
    );
  }

  // Records, proofs, the change feed

  getState<T = Record<string, unknown>>(key: string, opts?: ChainReadOptions) {
    return this.data<T>(`/v1/state/${segment(lower(key))}`, {}, opts);
  }

  getProof<T = Record<string, unknown>>(key: string, opts?: ChainReadOptions) {
    return this.data<T>(`/v1/proof/${segment(lower(key))}`, {}, opts);
  }

  /**
   * The finalized change feed from `from` (a height, or the `next` of an
   * earlier page): every finalized height up to `through` is given whole;
   * ask again from `next`. Throws ChainGatewayError code `gone` when the
   * gateway no longer holds that height, and `bad_answer` for a page
   * without a whole-height `through`.
   */
  async getChanges(
    from: ChainFeedCursor,
    opts: { readonly limit?: number; readonly families?: string[] } = {}
  ): Promise<ChainFeedPage> {
    const path = '/v1/feed';
    const { status, json } = await this.send('GET', path, {
      from: String(from),
      limit: opts.limit,
      families: opts.families?.join(',')
    });
    const answer = this.toAnswer<{
      through: number;
      blocks?: ChainFeedPage['blocks'];
      ranges?: unknown;
    }>(path, status, json);
    if (!answer) {
      throw new ChainGatewayError(`${path}: not found`, 404, 'not_found', path);
    }
    const through = answer.data.through;
    if (!Number.isSafeInteger(through) || !Array.isArray(answer.data.blocks)) {
      throw badAnswer(path, 'a page without its through height or blocks');
    }
    const blocks = answer.data.blocks;
    const nextHeight = through + 1;
    return {
      ...answer.data,
      from,
      through,
      blocks,
      next: answer.next ?? nextHeight,
      nextHeight,
      atHead: !blocks.length && through < feedCursorHeight(from),
      network: answer.read?.network ?? null
    };
  }

  getFeedFamilies(): Promise<Record<string, unknown> | null> {
    return this.data<Record<string, unknown>>(
      '/v1/feed/families',
      {},
      {
        at: 'head'
      }
    );
  }

  // Writes: drafts and relaying signed operations

  getOps(): Promise<Record<string, unknown> | null> {
    return this.data<Record<string, unknown>>('/v1/ops', {}, { at: 'head' });
  }

  /** The typed data to sign for one operation (POST /v1/draft). */
  async getDraft(request: ChainDraftRequest): Promise<ChainDraft> {
    return await this.post<ChainDraft>('/v1/draft', request);
  }

  /**
   * Relays a signed operation into the chain's mempool (POST /v1/submit).
   * The same bytes again answer with the same txId, so a retry is safe.
   * A refusal by the chain's rules throws code `inadmissible`.
   */
  async submit(request: ChainSubmitRequest): Promise<ChainSubmitResult> {
    return await this.post<ChainSubmitResult>('/v1/submit', request);
  }

  getTx(txId: string): Promise<ChainTx | null> {
    return this.data<ChainTx>(
      `/v1/tx/${segment(lower(txId))}`,
      {},
      {
        at: 'head'
      }
    );
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const { status, json } = await this.send('POST', path, {}, body);
    if (status !== 200 || !json || json.error || json.data === undefined) {
      throw this.errorOf(path, status, json);
    }
    return json.data as T;
  }

  // Documents (the gateway's document store)

  /**
   * The bytes of the profile document with this CID (hex, as identities
   * carry it), or null when the store has none. Checked against the CID.
   */
  async getProfileDoc(cid: string): Promise<Buffer | null> {
    return await this.getDocument(cid);
  }

  /**
   * The bytes of a sha2-256 document in the store (profile documents,
   * profile site files), by CID in hex or base32 text, or null when the
   * store has none. Checked against the CID; a CID that names another hash
   * is refused. Documents up to a profile document's size are cached.
   */
  async getDocument(cid: string): Promise<Buffer | null> {
    const key = cidHex(cid);
    if (!sha256DigestOf(hexToBytes(key))) {
      throw new ChainGatewayError(
        `Not a sha2-256 CID: ${cid}`,
        null,
        'bad_request',
        '/v1/docs'
      );
    }
    const cached = this.docs.get(key);
    if (cached) {
      // A copy: a caller that changes it can't change the cache.
      return Buffer.from(cached);
    }
    const path = `/v1/docs/${cidPath(key)}`;
    const { status, json, bytes } = await this.send(
      'GET',
      path,
      {},
      undefined,
      true
    );
    if (status === 404) {
      return null;
    }
    if (status !== 200 || !bytes) {
      throw this.errorOf(path, status, json);
    }
    if (!bytesMatchCid(key, bytes)) {
      throw new ChainGatewayError(
        `${path}: the document does not match its CID`,
        status,
        'cid_mismatch',
        path
      );
    }
    if (bytes.length <= DOC_CACHE_ENTRY_BYTES) {
      this.docs.set(key, Buffer.from(bytes));
    }
    return bytes;
  }

  /**
   * Stores bytes in the document store and returns their CID as base32
   * text. The document store's upload route: POST /v1/docs
   * with the bytes as application/octet-stream, at most 2 MiB, and an
   * optional `?cid=` it checks; it answers 201, or 200 when stored already,
   * with `{ cid, cid_hex, codec, size, url }`. The CID it names must be these
   * bytes' own. Storing the same bytes again is harmless.
   */
  async putDocument(bytes: Buffer): Promise<string> {
    const expected = rawCidHexOf(bytes);
    const path = '/v1/docs';
    const { status, json } = await this.send(
      'POST',
      path,
      { cid: cidPath(expected) },
      bytes
    );
    const stored = json as unknown as ChainStoredDoc | null;
    if ((status !== 200 && status !== 201) || !stored?.cid) {
      throw this.errorOf(path, status, json);
    }
    if (storedCidHex(stored.cid, path) !== expected) {
      throw new ChainGatewayError(
        `${path}: the store named the document ${stored.cid}, not ${cidPath(expected)}`,
        status,
        'cid_mismatch',
        path
      );
    }
    return cidPath(expected);
  }
}

/** The backend's one gateway client (settings read at first use). */
export const chainGatewayClient = new ChainGatewayClient();
