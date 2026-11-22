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
  ChainLevelRanking,
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
 *   latest finalized height it knows (refreshed every `headTtlMs`, and never
 *   below one already seen on that network, whatever a node behind says),
 *   so the reads of one task agree. A pinned answer must be read finalized at that
 *   height (a node that has it only as its head: `height_gone`); it never
 *   changes and is cached in memory (copies, by network, path, query and
 *   height, 64 MiB of JSON at most), except answers of the node's own data
 *   (wallet histories, saved membership and TDH days, a level it can't give
 *   yet). Unpinned list pages each follow the head: pin a walk to its first
 *   page's `read.height` to read one state. `opts.at = 'head'` reads the
 *   unfinalized head, uncached. A node that isn't ready still gives its
 *   status (503 with its stamps): the head says `ready: false`.
 * - Every answer must be of the chain the head names: another network id
 *   throws `wrong_network` (and the head is read again), a missing one
 *   `bad_answer`.
 * - Retries network errors, timeouts, 429 and 5xx with backoff (honouring
 *   Retry-After). The node's `not_found` 404 is `null`. An answer that can't
 *   be read (a 404 without the node's refusal, no read stamp or data, a list
 *   that isn't one, a feed page that doesn't hold together, past 16 MiB)
 *   throws `bad_answer`; a not_found of data the answering node doesn't
 *   hold (another may) throws `not_held`; other refusals throw
 *   ChainGatewayError carrying the API's code (`height_gone`, ...).
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
  arrayBuffer(): Promise<ArrayBuffer>;
  /** The body as a stream, when the fetch gives one: read with a cap. */
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
  } | null;
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
  /** The read stamp of the node's refusal, when it carried one. */
  read?: ChainReadStamp;

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

/** The document store's largest file. */
const MAX_DOC_BYTES = 2 * 1024 * 1024;
/** The node answers at most 8 MiB; past twice that, an answer is refused. */
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;
/** Cached answers take at most this many bytes (of JSON text) in all. */
const ANSWER_CACHE_TOTAL_BYTES = 64 * 1024 * 1024;
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

/** Whether a caller takes a retryable status's body as its answer. */
type Accept = (status: number, json: Envelope<unknown> | null) => boolean;

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
function badAnswer(
  path: string,
  what: string,
  status = 200
): ChainGatewayError {
  return new ChainGatewayError(`${path}: ${what}`, status, 'bad_answer', path);
}

/**
 * A response's bytes, refused (bad_answer) past `cap`: by its
 * content-length before reading, then while reading the stream.
 */
async function readCapped(
  response: Awaited<ReturnType<FetchLike>>,
  cap: number,
  path: string
): Promise<Buffer> {
  const tooLarge = () =>
    badAnswer(path, `an answer over ${cap} bytes`, response.status);
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > cap) throw tooLarge();
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > cap) throw tooLarge();
    return bytes;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/** A feed cursor's height and the index in that block to start at. */
function parseFeedCursor(cursor: ChainFeedCursor): {
  height: number;
  index: number;
} {
  const match = /^(\d+)(?::(\d+))?$/.exec(String(cursor));
  const height = Number(match?.[1]);
  const index = Number(match?.[2] ?? 0);
  if (!match || !Number.isSafeInteger(height) || !Number.isSafeInteger(index)) {
    throw new ChainGatewayError(
      `Not a feed cursor: ${cursor}`,
      null,
      'bad_request',
      '/v1/feed'
    );
  }
  return { height, index };
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

/** A feed record as the node writes it: a hex key, a value or null. */
function isFeedRecord(record: unknown): boolean {
  const it = record as { key?: unknown; value?: unknown } | null;
  return (
    !!it &&
    typeof it === 'object' &&
    typeof it.key === 'string' &&
    'value' in it &&
    (it.value === null || typeof it.value === 'string')
  );
}

/**
 * A feed page holds together, as the node writes it: blocks are whole
 * heights, rising, none below the height asked from; the block asked from
 * inside starts at the cursor's index, every other at 0; only the last
 * block may be cut, and then it is the block after `through` and `next`
 * names a later index in it (exactly past its records without a family
 * filter); otherwise `next` is the height after
 * `through`, or the height asked from when the node is behind it.
 */
function checkFeedPage(
  path: string,
  from: { readonly height: number; readonly index: number },
  through: number,
  blocks: unknown,
  next: string | null,
  filtered: boolean
): ChainFeedPage['blocks'] {
  if (!Number.isSafeInteger(through) || through < 0 || !Array.isArray(blocks)) {
    throw badAnswer(path, 'a page without its through height or blocks');
  }
  const list = blocks as ChainFeedPage['blocks'];
  let previous = from.height - 1;
  list.forEach((block, i) => {
    const height: unknown = block?.height;
    const last = i === list.length - 1;
    const cut = block?.complete === false;
    const recordsFrom = height === from.height ? from.index : 0;
    if (
      typeof height !== 'number' ||
      !Number.isSafeInteger(height) ||
      height <= previous ||
      !Array.isArray(block.records) ||
      !block.records.every(isFeedRecord) ||
      typeof block.complete !== 'boolean' ||
      block.recordsFrom !== recordsFrom ||
      (cut ? !last || height !== through + 1 : height > through)
    ) {
      throw badAnswer(
        path,
        'a block out of order, past the page or unreadable'
      );
    }
    previous = height;
  });
  // A page from inside a block that reaches past it starts with that block.
  if (
    from.index > 0 &&
    through >= from.height &&
    list[0]?.height !== from.height
  ) {
    throw badAnswer(
      path,
      'a page that does not resume the block it was asked from'
    );
  }
  const last = list[list.length - 1];
  let fits: boolean;
  if (last?.complete === false) {
    const inside = /^(\d+):(\d+)$/.exec(String(next));
    // The index counts every write of the block: without a family filter
    // the page holds exactly those from recordsFrom to it.
    const from = Number(last.recordsFrom);
    const index = Number(inside?.[2]);
    // A page always moves on: the cut block holds a record at least.
    fits =
      !!inside &&
      Number(inside[1]) === last.height &&
      last.records.length > 0 &&
      (filtered ? index > from : index === from + last.records.length);
  } else {
    const whole = Math.max(through + 1, from.height);
    fits = next === null || (/^\d+$/.test(next) && Number(next) === whole);
  }
  if (!fits) {
    throw badAnswer(path, 'a next that is not where the page ends');
  }
  return list;
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

/** A network id: 32 bytes of hex. */
const NETWORK_ID = /^0x[0-9a-f]{64}$/i;

/** A read stamp as the node writes it. */
function isReadStamp(value: unknown): value is ChainReadStamp {
  const it = value as Partial<ChainReadStamp> | null;
  const heights = [it?.height, it?.finalizedHeight, it?.headHeight];
  return (
    !!it &&
    typeof it === 'object' &&
    (it.at === 'finalized' || it.at === 'head') &&
    heights.every((n) => Number.isSafeInteger(n) && (n as number) >= 0) &&
    typeof it.network === 'string' &&
    NETWORK_ID.test(it.network)
  );
}

/**
 * not_found answers of the node rather than of the data, told apart only by
 * their message (the node's texts, routes.rs): never null, never cached.
 * The node should send codes of its own for these (such as `not_held`).
 * - A route an older release lacks: `bad_answer`.
 * - Data this node doesn't hold, which another node may: `not_held`. The
 *   import's entry on a node whose release carries no identities file, a
 *   membership day it didn't save or has no record of, a TDH day's lists
 *   it doesn't keep, token rows it never computed.
 * The identity's `founder` depends on the identities file the same way:
 * for an imported identity the node takes it from the file it carries
 * (reads.rs, `founder`), so a node without it can name another wallet.
 * That one is for the API to settle; the client can't tell.
 */
const NO_SUCH_ROUTE = /^no such route/i;
const NOT_HELD = [
  /^this node's chain imports no identities file/i,
  /^this node didn't save day \d+/i,
  /^no MembershipDay record of day \d+ here/i,
  /^this node holds no lists of TDH day \d+/i,
  /^this node has no token rows/i
];

/** An identity whose level the node can't give yet (its TDH lists). */
function lacksLevel(value: unknown): boolean {
  const it = value as { principalId?: unknown; level?: unknown } | null;
  return (
    !!it && typeof it === 'object' && 'principalId' in it && it.level === null
  );
}

/**
 * Whether an answer comes from the node's own data rather than the state at
 * the height read, so it can change at that height: wallet histories and
 * their ranges (written by the feed), the membership summary and its saved
 * days, every TDH read (its lists are copied after the state), a proof
 * without its state proof, and a level the node can't give until it has
 * copied the TDH lists (null alone or in an identity).
 */
function nodeLocal(path: string, data: unknown): boolean {
  if (
    /\/history$/.test(path) ||
    path === '/v1/membership' ||
    path.startsWith('/v1/membership/days/') ||
    path === '/v1/tdh' ||
    path.startsWith('/v1/tdh/')
  ) {
    return true;
  }
  // A proof the node can't give yet (no state proof at that height).
  if (
    path.startsWith('/v1/proof/') &&
    (data as { stateProof?: unknown } | null)?.stateProof === null
  ) {
    return true;
  }
  if (path.startsWith('/v1/levels/') && data === null) return true;
  let rows: unknown[] = [data];
  if (Array.isArray(data)) {
    rows = data;
  } else if (data && typeof data === 'object' && !('principalId' in data)) {
    rows = Object.keys(data).map(
      (key) => (data as Record<string, unknown>)[key]
    );
  }
  return rows.some(lacksLevel);
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
  /** The highest finalized height seen on the head's network. */
  /**
   * The highest finalized height seen on each network: kept per network,
   * so a status flipping between two during a relaunch keeps both.
   */
  private readonly pinFloors = new Map<string, number>();
  private caches: {
    /** JSON text of answers (`null` for a 404), parsed afresh on each hit. */
    readonly answers: LruCache<string>;
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
        answers: new LruCache<string>(
          resolved.cacheEntries,
          (text) => text.length,
          ANSWER_CACHE_TOTAL_BYTES
        ),
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

  private get answers(): LruCache<string> {
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
    this.pinFloors.clear();
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
    binary: boolean,
    accept?: Accept
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
        const json = await this.parse(response, path);
        if (accept?.(response.status, json)) {
          return { ok: true, status: response.status, json };
        }
        const error = this.errorOf(path, response.status, json);
        return {
          ok: false,
          error: Object.assign(error, {
            retryAfterMs: this.retryAfterMs(response.headers.get('retry-after'))
          })
        };
      }
      if (binary && response.status === 200) {
        // Past the store's largest file: refused before or while reading.
        const bytes = await readCapped(response, MAX_DOC_BYTES, path);
        return { ok: true, status: 200, json: null, bytes };
      }
      return {
        ok: true,
        status: response.status,
        json: await this.parse(response, path)
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
    binary = false,
    accept?: Accept
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
      const result = await this.attempt(
        method,
        path,
        url,
        body,
        binary,
        accept
      );
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

  private async parse(
    response: Awaited<ReturnType<FetchLike>>,
    path: string
  ): Promise<Envelope<unknown> | null> {
    const text = (await readCapped(response, MAX_ANSWER_BYTES, path)).toString(
      'utf8'
    );
    if (!text) return null;
    try {
      return JSON.parse(text) as Envelope<unknown>;
    } catch {
      // A proxy's page for an error status keeps that status's code.
      const code =
        response.status === 200 ? 'bad_answer' : `http_${response.status}`;
      return { error: { code, message: text.slice(0, 200) } };
    }
  }

  private errorOf(
    path: string,
    status: number,
    json: Envelope<unknown> | null
  ): ChainGatewayError {
    const error = json?.error;
    // A node with no state answers its status 503 with why, and no error.
    const notReady = (json?.data as { notReady?: unknown } | undefined)
      ?.notReady;
    const starting = status === 503 && typeof notReady === 'string';
    // A 200 that can't be read (empty, no data) is the gateway's fault.
    const fallback = status === 200 ? 'bad_answer' : `http_${status}`;
    const code =
      (typeof error === 'string' ? error : error?.code) ??
      (starting ? 'starting' : fallback);
    const message =
      (typeof error === 'string' ? json?.message : error?.message) ??
      (starting ? (notReady as string) : `HTTP ${status}`);
    return new ChainGatewayError(
      `${path}: ${code}: ${message}`,
      status,
      code,
      path
    );
  }

  /**
   * The node's answer with its read stamp, or null for its `not_found`
   * refusal. Every answer must be of the chain the head names
   * (`wrong_network`); one that can't be read is `bad_answer` (a 404
   * without the node's refusal, a 200 without its stamp or data); other
   * refusals throw with their code.
   */
  private async toAnswer<T>(
    path: string,
    status: number,
    json: Envelope<unknown> | null
  ): Promise<{ read: ChainReadStamp; answer: ChainAnswer<T> | null }> {
    const stamp = json?.read;
    let read: ChainReadStamp | undefined;
    if (stamp !== undefined && stamp !== null) {
      if (!isReadStamp(stamp)) {
        throw badAnswer(path, `a read stamp that can't be read`, status);
      }
      read = stamp;
      await this.checkNetwork(path, status, read);
    }
    const error = json?.error;
    const code = typeof error === 'string' ? error : error?.code;
    if (status === 404) {
      if (!read || code !== 'not_found') {
        throw badAnswer(path, `a 404 that isn't the node's not_found`, 404);
      }
      // Some not_found answers are of the node, not of the data (see
      // NOT_HELD): never null or cached.
      const message = typeof error === 'string' ? '' : (error?.message ?? '');
      if (NO_SUCH_ROUTE.test(message)) {
        throw badAnswer(
          path,
          `the node that answered can't say: ${message}`,
          404
        );
      }
      if (NOT_HELD.some((it) => it.test(message))) {
        const notHeld = new ChainGatewayError(
          `${path}: not_held: ${message}`,
          404,
          'not_held',
          path
        );
        notHeld.read = read;
        throw notHeld;
      }
      return { read, answer: null };
    }
    if (status !== 200 || !json || error) {
      const failure = this.errorOf(path, status, json);
      if (read) failure.read = read;
      throw failure;
    }
    if (!read || json.data === undefined) {
      throw badAnswer(path, 'an answer without its read stamp or data');
    }
    const next =
      json.next === undefined || json.next === null ? null : String(json.next);
    return { read, answer: { read, data: json.data as T, next } };
  }

  /**
   * An answer is of the chain the head names. Another network (a relaunch,
   * or a gateway mixing nodes across one) is refused, and the head is read
   * again so the reads after it follow a relaunch.
   */
  private async checkNetwork(
    path: string,
    status: number,
    read: ChainReadStamp
  ) {
    const network = read.network;
    const expected = (await this.getHead()).network;
    if (lower(network) === expected) return;
    await this.getHead(true).catch(() => undefined);
    throw new ChainGatewayError(
      `${path}: read from network ${network}, not ${expected}`,
      status,
      'wrong_network',
      path
    );
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
          const head = status?.head?.height;
          const finalized = status?.finalized ?? null;
          const network = finalized?.network;
          if (
            !Number.isSafeInteger(head) ||
            !Number.isSafeInteger(finalized?.height) ||
            typeof finalized?.time !== 'number' ||
            typeof network !== 'string' ||
            !NETWORK_ID.test(network)
          ) {
            throw badAnswer(
              '/v1/status',
              'a status without its heights or network id'
            );
          }
          const value: ChainHead = {
            headHeight: head as number,
            finalizedHeight: finalized!.height,
            finalizedTime: finalized!.time,
            pinnable: status.pinnable ?? null,
            network: lower(network),
            ready: status.ready === true,
            notReady:
              typeof status.notReady === 'string' ? status.notReady : null
          };
          // Answers are kept by network, and dropped on another one (a
          // relaunch: the same heights mean other blocks).
          const before = this.head?.value.network ?? null;
          if (before !== null && before !== value.network) {
            this.caches?.answers.clear();
          }
          // Reads never pin below a finalized height already seen on this
          // network (a node behind the others can answer the status), and
          // the head says so: its finalized height never goes back.
          this.raiseFloor(value.network!, value.finalizedHeight);
          const steady: ChainHead = {
            ...value,
            finalizedHeight: this.pinOf(value),
            nodeFinalizedHeight: value.finalizedHeight
          };
          this.head = { value: steady, at: this.now() };
          return steady;
        } finally {
          this.headInFlight = null;
        }
      })();
    }
    return await this.headInFlight;
  }

  /**
   * The node's status. A node that isn't ready (behind, or its driver
   * stalled) answers 503 with the same body while it has a state to read:
   * that is its status, taken as it is and not retried.
   */
  async getStatus(): Promise<ChainStatus> {
    const path = '/v1/status';
    const stamped: Accept = (status, json) =>
      status === 503 &&
      !!(json?.data as Partial<ChainStatus> | undefined)?.finalized;
    const { status, json } = await this.send(
      'GET',
      path,
      {},
      undefined,
      false,
      stamped
    );
    if ((status !== 200 && !stamped(status, json)) || !json?.data) {
      throw this.errorOf(path, status, json);
    }
    return json.data as ChainStatus;
  }

  /**
   * Any read route: the answer, or null for 404. Pinned as the class says.
   * Use the typed methods below where one exists. Not for routes the node
   * refuses a height on: `/v1/identities/by-level` (getLevelRanking).
   */
  async read<T>(
    path: string,
    query: Query = {},
    opts: ChainReadOptions = {}
  ): Promise<ChainAnswer<T> | null> {
    if (opts.at === 'head' && opts.height !== undefined) {
      throw new ChainGatewayError(
        `${path}: a read is of the head or at a height, not both`,
        null,
        'bad_request',
        path
      );
    }
    if (opts.at === 'head') {
      const { status, json } = await this.send('GET', path, {
        ...query,
        at: 'head'
      });
      return (await this.toAnswer<T>(path, status, json)).answer;
    }
    if (opts.height !== undefined) {
      return await this.pinnedUntilHeld<T>(path, query, opts.height);
    }
    const head = await this.getHead();
    try {
      return await this.pinnedUntilHeld<T>(path, query, this.pinOf(head));
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
    const pin = this.pinOf(fresh);
    try {
      return await this.pinnedUntilHeld<T>(path, query, pin);
    } catch (error) {
      if (
        !(error instanceof ChainGatewayError) ||
        error.code !== 'height_gone'
      ) {
        throw error;
      }
    }
    const { status, json } = await this.send('GET', path, query);
    const { read, answer } = await this.toAnswer<T>(path, status, json);
    // Read unpinned, the answer is of the answering node's head: one behind
    // the height reads already pinned would take them back.
    if (read.height < pin) {
      throw new ChainGatewayError(
        `${path}: answered at ${read.height}, below the height ${pin} already read`,
        409,
        'height_gone',
        path
      );
    }
    // A finalized height read is one the next reads don't go below.
    if (read.at === 'finalized') {
      this.raiseFloor(lower(read.network), read.height);
    }
    return answer;
  }

  /**
   * A pinned read, waited for while the node that answers says it hasn't
   * finalized that height yet (its refusal's stamp is below it): two nodes
   * a block apart behind the load balancer. Up to the client's retries.
   */
  private async pinnedUntilHeld<T>(
    path: string,
    query: Query,
    height: number
  ): Promise<ChainAnswer<T> | null> {
    const config = this.config();
    const sleep =
      config.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.pinnedRead<T>(path, query, height);
      } catch (error) {
        const notYet =
          error instanceof ChainGatewayError &&
          error.code === 'height_gone' &&
          error.read !== undefined &&
          error.read.finalizedHeight < height;
        if (!notYet || attempt >= config.retries) throw error;
        await sleep(Math.min(1_000, 250 * 2 ** attempt));
      }
    }
  }

  /** The height a read without one pins: the head's, never going down. */
  private pinOf(head: ChainHead): number {
    const floor = head.network ? this.pinFloors.get(head.network) : undefined;
    return Math.max(floor ?? 0, head.finalizedHeight);
  }

  private raiseFloor(network: string, height: number) {
    this.pinFloors.set(
      network,
      Math.max(this.pinFloors.get(network) ?? 0, height)
    );
  }

  private async pinnedRead<T>(
    path: string,
    query: Query,
    height: number
  ): Promise<ChainAnswer<T> | null> {
    // Kept by network too: an answer of another chain is never served.
    // The head as of now (read again past its TTL): after a relaunch the
    // old chain's answers are not looked up.
    const network = (await this.getHead()).network;
    const url = this.url(path, { ...query, height });
    const cached = this.answers.get(`${network} ${url}`);
    if (cached !== undefined) {
      // Parsed afresh: a caller that changes an answer can't change the cache.
      return JSON.parse(cached) as ChainAnswer<T> | null;
    }
    const { status, json } = await this.send('GET', path, { ...query, height });
    const { read, answer } = await this.toAnswer<T>(path, status, json);
    // A node that has the height only as its head answers from there: not
    // the finalized state pinned, so the height is gone for this read.
    if (read.at !== 'finalized') {
      const notFinal = new ChainGatewayError(
        `${path}: height ${height} is not finalized on the node that answered`,
        409,
        'height_gone',
        path
      );
      notFinal.read = read;
      throw notFinal;
    }
    if (read.height !== height) {
      throw badAnswer(
        path,
        `an answer at height ${read.height}, not ${height}`
      );
    }
    // Kept under the network it was read from, whatever the head was when
    // it was asked; not kept when it is the node's own data rather than the
    // state at that height.
    if (!nodeLocal(path, answer?.data)) {
      this.answers.set(`${lower(read.network)} ${url}`, JSON.stringify(answer));
    }
    return answer;
  }

  private async data<T>(
    path: string,
    query: Query = {},
    opts: ChainReadOptions = {}
  ): Promise<T | null> {
    return (await this.read<T>(path, query, opts))?.data ?? null;
  }

  /**
   * One page of a list. Without `opts.height` each page is pinned to the
   * head as of that call, so a walk over many pages can span heights:
   * pin every page to the first page's `read.height` to read one state.
   */
  private async page<T>(
    path: string,
    query: Query,
    opts: ChainPageOptions,
    items: (data: unknown) => unknown = (data) => data
  ): Promise<ChainPage<T> | null> {
    const answer = await this.read<unknown>(
      path,
      { ...query, after: opts.after ?? undefined, limit: opts.limit },
      opts
    );
    if (!answer) return null;
    const rows = items(answer.data);
    // A list that isn't one would read as empty: a rebuild could delete
    // every row it then doesn't see.
    if (!Array.isArray(rows)) {
      throw badAnswer(path, 'a list that is not a list');
    }
    return { items: rows as T[], next: answer.next, read: answer.read };
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

  /**
   * Wallet to identity (null: unbound), 100 wallets a call. Every chunk is
   * read at one height, except with `at: 'head'`: each chunk then reads the
   * head as of its call (the node pins no head), so chunks can differ by a
   * block.
   */
  async getIdentitiesByWallets(
    wallets: string[],
    opts: ChainReadOptions = {}
  ): Promise<Record<string, ChainIdentity | null>> {
    const distinct = Array.from(new Set(wallets.map(lower)));
    if (!distinct.length) return {};
    if (opts.at === 'head' || opts.height !== undefined) {
      return await this.walletsAt(distinct, opts);
    }
    try {
      return await this.walletsAt(distinct, {
        height: this.pinOf(await this.getHead())
      });
    } catch (error) {
      if (
        !(error instanceof ChainGatewayError) ||
        error.code !== 'height_gone'
      ) {
        throw error;
      }
    }
    // A node that doesn't hold that height: every chunk again at a fresh
    // one, once, so that all the chunks are read at one height.
    return await this.walletsAt(distinct, {
      height: this.pinOf(await this.getHead(true))
    });
  }

  private async walletsAt(
    distinct: string[],
    pinned: ChainReadOptions
  ): Promise<Record<string, ChainIdentity | null>> {
    const result: Record<string, ChainIdentity | null> = {};
    for (let i = 0; i < distinct.length; i += 100) {
      const chunk = distinct.slice(i, i + 100);
      const path = '/v1/identities/by-wallets';
      const data = await this.data<Record<string, ChainIdentity | null>>(
        path,
        { wallets: chunk.join(',') },
        pinned
      );
      for (const wallet of chunk) {
        // A wallet left out would read as unbound.
        if (!data || !Object.prototype.hasOwnProperty.call(data, wallet)) {
          throw badAnswer(path, `no answer for ${wallet}`);
        }
        result[wallet] = data[wallet] ?? null;
      }
    }
    return result;
  }

  listIdentities(opts: ChainPageOptions = {}) {
    return this.page<ChainIdentity>('/v1/identities', {}, opts);
  }

  /**
   * Identities by level, highest first, a page at a time. The node ranks
   * its latest finalized state and refuses a height or the head here, so
   * this read is neither pinned nor cached (`rankedAt` says its height).
   */
  async getLevelRanking(
    opts: { readonly after?: string | null; readonly limit?: number } = {}
  ): Promise<ChainAnswer<ChainLevelRanking>> {
    const path = '/v1/identities/by-level';
    const { status, json } = await this.send('GET', path, {
      after: opts.after ?? undefined,
      limit: opts.limit
    });
    const { answer } = await this.toAnswer<ChainLevelRanking>(
      path,
      status,
      json
    );
    if (!answer || !Array.isArray(answer.data?.rows)) {
      throw badAnswer(path, 'a ranking without its rows');
    }
    return answer;
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
   * A wallet's binding changes, exact within the returned range (the first
   * the feed holds, to the read height; see below), and the read height.
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
    // Only the first range the feed holds is exact, and only to the read
    // height (the node reads the history from its feed whatever the height
    // asked). The node builds a history from feed blocks alone: after a gap
    // it starts again from the membership without writing it into the
    // history (feed.rs, Start), and a change back to the principal it last
    // noted before the gap is skipped (feed.rs, note). So a later range can
    // hold wrong values: it is dropped, with every change past the first.
    // For the API: an `exactFrom`, or Start writing the bindings it loads
    // into the history, would make later ranges usable.
    const height = readHeight as number;
    const first = heightRanges(answer.data.ranges, path)[0];
    const ranges: [number, number][] =
      first && first[0] <= height
        ? [[first[0], Math.min(first[1], height)]]
        : [];
    const end = ranges.length ? ranges[0][1] : -1;
    return {
      wallet: lower(wallet),
      changes: bindingChanges(answer.data.changes, path).filter(
        (it) => it.height <= end
      ),
      ranges,
      readHeight: height
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
      (data) => (data as ChainMembershipDayWallets | null)?.wallets
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
   * ask again from `next`. A node behind the height asked from answers an
   * empty page (`atHead`) and `nextHeight` stays at that height. Throws
   * ChainGatewayError code `gone` when the gateway no longer holds that
   * height, `bad_request` for a cursor that isn't one, `wrong_network` for
   * a page of another chain, and `bad_answer` for a page that doesn't hold
   * together (see checkFeedPage).
   */
  async getChanges(
    from: ChainFeedCursor,
    opts: { readonly limit?: number; readonly families?: string[] } = {}
  ): Promise<ChainFeedPage> {
    const path = '/v1/feed';
    const cursor = parseFeedCursor(from);
    const query = {
      from: String(from),
      limit: opts.limit,
      families: opts.families?.join(',')
    };
    const readPage = async () => {
      const { status, json } = await this.send('GET', path, query);
      return await this.toAnswer<{
        through: number;
        blocks?: unknown;
        ranges?: unknown;
      }>(path, status, json);
    };
    // Each node keeps its own feed from its own start: a younger one behind
    // the load balancer can say gone for a height an older one holds, so a
    // gone is asked again, up to the client's retries.
    const config = this.config();
    const sleep =
      config.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let page: Awaited<ReturnType<typeof readPage>> | null = null;
    for (let attempt = 0; page === null; attempt++) {
      try {
        page = await readPage();
      } catch (error) {
        const gone =
          error instanceof ChainGatewayError && error.code === 'gone';
        if (!gone || attempt >= config.retries) throw error;
        await sleep(this.backoff(attempt + 1, error));
      }
    }
    const { answer } = page;
    if (!answer) {
      throw new ChainGatewayError(`${path}: not found`, 404, 'not_found', path);
    }
    const data = answer.data ?? ({} as typeof answer.data);
    const through = data.through;
    // The feed is cut at the finalized height the answer is stamped with.
    if (Number.isSafeInteger(through) && through > answer.read.height) {
      throw badAnswer(path, `a page through ${through}, past its read height`);
    }
    const past = Array.isArray(data.blocks)
      ? (data.blocks as { height?: unknown }[]).some(
          (block) =>
            typeof block?.height === 'number' &&
            block.height > answer.read.height
        )
      : false;
    if (past) {
      throw badAnswer(path, 'a block past the read height');
    }
    const blocks = checkFeedPage(
      path,
      cursor,
      through,
      data.blocks,
      answer.next,
      !!opts.families?.length
    );
    // A node behind the height asked from answers through its own head:
    // the next height stays where the reader is.
    const nextHeight = Math.max(through + 1, cursor.height);
    const atHead = !blocks.length && through < cursor.height;
    return {
      ...data,
      from,
      through,
      blocks,
      // A node behind a cursor inside a block answers its height alone:
      // the cursor asked is kept, so the block's start isn't read again.
      next: atHead ? from : (answer.next ?? nextHeight),
      nextHeight,
      atHead,
      network: lower(answer.read.network)
    };
  }

  /**
   * The feed's family table (names, key and value fields), for decoding
   * records generically. The node serves it without a read stamp (it reads
   * no state), so it is taken as it is.
   */
  async getFeedFamilies(): Promise<Record<string, unknown>> {
    const path = '/v1/feed/families';
    const { status, json } = await this.send('GET', path, {});
    if (status !== 200 || !json || json.error) {
      throw this.errorOf(path, status, json);
    }
    if (!json.data || typeof json.data !== 'object') {
      throw badAnswer(path, 'no family table');
    }
    return json.data as Record<string, unknown>;
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
    const stamp = json?.read;
    const stamped = stamp !== undefined && stamp !== null;
    if (stamped) {
      if (!isReadStamp(stamp)) {
        throw badAnswer(path, `a read stamp that can't be read`, status);
      }
      await this.checkNetwork(path, status, stamp);
    }
    if (status !== 200 || !json || json.error) {
      throw this.errorOf(path, status, json);
    }
    if (!stamped || json.data === undefined) {
      throw badAnswer(path, 'an answer without its read stamp or data');
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
      // The store's own "none": its not_found, or the bucket's NoSuchKey.
      // Anything else (a misrouted request) says nothing of the document.
      const error = json?.error;
      const code = typeof error === 'string' ? error : error?.code;
      const message =
        (typeof error === 'string' ? json?.message : error?.message) ?? '';
      const none =
        code === 'not_found' ||
        (code === 'http_404' && /<Code>NoSuchKey<\/Code>/.test(message));
      if (!none) {
        throw badAnswer(path, `a 404 that isn't the store's`, 404);
      }
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
