import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Logger } from '@/logging';
import { tokenRoot, walletRoot } from './p28';
import {
  bodyText,
  RateLimitedFetcher,
  withoutTrailingSlashes
} from './rate-limited-fetcher';
import { parseDayFiles } from './tdh-day-file';
import { dateOfCycleDay } from './site-day';
import {
  TdhChainDay,
  TdhChainDayInfo,
  TdhDayApply,
  TdhDayHeader,
  TdhTokenLeaf,
  TdhWalletLeaf
} from './tdh-chain.types';

/**
 * Where the site reads the chain's TDH days:
 *
 * - `latestDay`, `day`: a day's `TdhDay` record and where it applied;
 * - `walletLeaves`: the day's wallet list (P28 4.3);
 * - `tokenLeaves`: the day's token list (P28 4.12), null when not served.
 *
 * The answers are checked by `verifyChainDay` before use; a source fetches,
 * decodes and checks only what its transport needs.
 */
export interface TdhChainSource {
  /** The newest applied day the source holds as final, or null. */
  latestDay(): Promise<TdhChainDayInfo | null>;
  /** One applied day, or null when the source has none by that number. */
  day(cycleDay: number): Promise<TdhChainDayInfo | null>;
  walletLeaves(cycleDay: number): Promise<TdhWalletLeaf[]>;
  /** Null when the source doesn't serve token lists. */
  tokenLeaves(cycleDay: number): Promise<TdhTokenLeaf[] | null>;
}

export async function readChainDay(
  source: TdhChainSource,
  cycleDay: number
): Promise<TdhChainDay | null> {
  const info = await source.day(cycleDay);
  if (!info) return null;
  const walletLeaves = await source.walletLeaves(cycleDay);
  const tokenLeaves = await source.tokenLeaves(cycleDay);
  return { ...info, walletLeaves, tokenLeaves };
}

export class TdhChainSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** An answer in a shape the client doesn't read, or one its checks refuse. */
export class TdhChainShapeError extends TdhChainSourceError {}

/**
 * The gateway has no such route: its URL is wrong, or it runs another
 * release. A configuration error, never "no day yet".
 */
export class TdhGatewayRouteError extends TdhChainSourceError {}

/* ---------- decoding the gateway's answers ---------- */

/**
 * A whole number. The gateway sends counts and heights as JSON numbers and
 * TDH values as decimal strings; every value must be below 2^53.
 */
function jsonUint(obj: any, key: string): number {
  const v = obj?.[key];
  const n = typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    throw new TdhChainShapeError(`${key}: ${JSON.stringify(v)} is not a uint`);
  }
  return n;
}

function jsonHex(obj: any, key: string, bytes: number, what: string): string {
  const v = obj?.[key];
  const pattern = new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`);
  if (typeof v !== 'string' || !pattern.test(v)) {
    throw new TdhChainShapeError(`${key}: ${JSON.stringify(v)} is not ${what}`);
  }
  return v.toLowerCase();
}

const jsonHash = (obj: any, key: string) => jsonHex(obj, key, 32, 'a bytes32');
const jsonAddress = (obj: any, key: string) =>
  jsonHex(obj, key, 20, 'an address');

function jsonDecimal(obj: any, key: string): string {
  const v = obj?.[key];
  if (typeof v !== 'string' || !/^(0|[1-9]\d*)$/.test(v)) {
    throw new TdhChainShapeError(
      `${key}: ${JSON.stringify(v)} is not a decimal string`
    );
  }
  return v;
}

/**
 * A `TdhDay` record as `/v1/tdh` and `/v1/tdh/days/{day}` give it, with the
 * read stamp of its answer. The gateway reads finalized state, so the day is
 * final; it doesn't say at which height the day applied.
 */
export function decodeTdhDay(data: any, read?: any): TdhChainDayInfo {
  const cutoff = data?.cutoff;
  const header: TdhDayHeader = {
    cycleDay: jsonUint(data, 'day'),
    boundary: jsonUint(data, 'boundary'),
    tdhRuleId: jsonHash(data, 'tdhRuleId'),
    cutoffNumber: jsonUint(cutoff, 'number'),
    cutoffHash: jsonHash(cutoff, 'hash'),
    cutoffTimestamp: jsonUint(cutoff, 'timestamp'),
    walletRoot: jsonHash(data, 'walletRoot'),
    walletCount: jsonUint(data, 'walletCount'),
    identityCount: jsonUint(data, 'identityCount'),
    totalTdh: jsonUint(data, 'totalTdh'),
    tokenRoot: jsonHash(data, 'tokenRoot'),
    tokenCount: jsonUint(data, 'tokenCount')
  };
  const finalized = read?.finalizedHeight ?? read?.height;
  const apply: TdhDayApply = {
    applyHeight: null,
    applyBlockHash: null,
    applyTimeMs: null,
    finalizedHeight:
      finalized === undefined || finalized === null
        ? null
        : jsonUint({ finalizedHeight: finalized }, 'finalizedHeight')
  };
  return { header, apply };
}

/** The `rows` of a wallet list chunk. */
export function decodeWalletRows(rows: unknown): TdhWalletLeaf[] {
  if (!Array.isArray(rows)) {
    throw new TdhChainShapeError('a wallet list chunk has no rows');
  }
  return rows.map((r) => ({
    wallet: jsonAddress(r, 'wallet'),
    cid: jsonHash(r, 'cid'),
    identityTdh: jsonUint(r, 'identityTdh'),
    walletTdh: jsonUint(r, 'walletTdh'),
    walletCount: jsonUint(r, 'walletCount')
  }));
}

/** The `rows` of a token list chunk. */
const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);

/**
 * A uint256 token id, as decimal text: the gateway sends it in decimal, or
 * as `0x` hex past 128 bits.
 */
function jsonTokenId(obj: any, key: string): string {
  const v = obj?.[key];
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v)) {
    return BigInt(v).toString();
  }
  const decimal = jsonDecimal(obj, key);
  if (BigInt(decimal) > MAX_UINT256) {
    throw new TdhChainShapeError(`${key}: ${decimal} is above 2^256 - 1`);
  }
  return decimal;
}

/**
 * The `rows` of a token list chunk: `{ cid, contract, tokenId, tokenTdh }`,
 * in the token root's order (cid, contract, tokenId ascending).
 */
export function decodeTokenRows(rows: unknown): TdhTokenLeaf[] {
  if (!Array.isArray(rows)) {
    throw new TdhChainShapeError('a token list chunk has no rows');
  }
  return rows.map((r) => ({
    cid: jsonHash(r, 'cid'),
    contract: jsonAddress(r, 'contract'),
    tokenId: jsonTokenId(r, 'tokenId'),
    tokenTdh: jsonUint(r, 'tokenTdh')
  }));
}

/* ---------- the gateway ---------- */

/** Rows asked for per chunk: the gateway's cap. */
export const GATEWAY_PAGE_SIZE = 5000;
/** Chunks of one list before the read gives up on a looping cursor. */
const MAX_CHUNKS = 1000;
/** Pins tried when a pinned height or a list is gone. */
const MAX_PINS = 3;

/** The gateway no longer holds the pinned height. */
class HeightGoneError extends TdhChainSourceError {}
/** A list, or a chunk of it, is gone: read the list again at a fresh pin. */
class ListGoneError extends TdhChainSourceError {}

const logger = Logger.get('TDH_CHAIN_SOURCE');

interface GatewayAnswer {
  readonly status: number;
  /** A 404 because the gateway has no such route, not no such day. */
  readonly noSuchRoute?: boolean;
  readonly read?: any;
  readonly data?: any;
  readonly next?: unknown;
}

interface KnownDay {
  readonly header: TdhDayHeader;
  readonly pin: number | null;
}

/**
 * The 6529 chain gateway's TDH routes (the node's API mode):
 *
 * - `GET /v1/tdh`: the day the finalized state applies now;
 * - `GET /v1/tdh/days/{day}`: that day's `TdhDay` record; 404 once the
 *   state no longer holds it;
 * - `GET /v1/tdh/days/{day}/wallets?after=&limit=`: the wallet list in
 *   chunks, `{ day, walletRoot, walletCount, identityCount, rows }`, rows
 *   ascending by wallet, `next` the cursor of the next chunk (null at the
 *   end). The node keeps the latest two days' lists;
 * - `GET /v1/tdh/days/{day}/tokens?after=&limit=`: the token list in the
 *   same chunks, `{ day, tokenRoot, tokenCount, rows }`, rows of `{ cid,
 *   contract, tokenId, tokenTdh }` in the token root's order. A node that
 *   got the day by handover, or a release without the route, answers 404:
 *   the list is asked for again at fresh pins (two nodes stand behind one
 *   URL), and after the last 404, or an answer the client can't read or
 *   check, the day has no token list (logged), so a compare is
 *   MATCH_WITHOUT_TOKENS.
 *
 * Every answer is `{ read, data, next }`. A 404 whose error says "no such
 * route" means a wrong base URL or another release, and fails loudly
 * (`TdhGatewayRouteError`); any other 404 on a day is no such day. While no
 * API node serves, the gateway answers 503 `nodes_unavailable`: after the
 * fetcher's retries that is a `TdhChainSourceError`, which the poller reads
 * as the gateway being down and the compare tool as a failed read.
 *
 * A day's lists are read pinned (`?height=`) at the finalized height in the
 * record's answer (`read.finalizedHeight`). It is a height the node held
 * when it answered, as `/v1/status` would give it, without a request of its
 * own; a node behind the one that answered refuses it with a 409, and the
 * read re-pins. The pin keeps the record's read stable, and pinned answers
 * are cached at the gateway's edge. The gateway serves the lists from what
 * the node holds, so the pin doesn't make the chunks one read: what rules
 * out a list put together from two is that every chunk must name the day's
 * root and counts, and the root rebuilt from all the rows must equal the
 * day's. If the pinned height is gone (409 `height_gone`), or a list or one
 * of its chunks is gone (404, as from a second node behind the same URL that
 * doesn't hold the lists yet), the record and the list are read again from
 * the start at a fresh pin, three pins at most.
 */
export class GatewayTdhChainSource implements TdhChainSource {
  private readonly days = new Map<number, KnownDay>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: RateLimitedFetcher,
    private readonly pageSize: number = GATEWAY_PAGE_SIZE
  ) {}

  private async get(
    route: string,
    query: Record<string, string | number | null> = {}
  ): Promise<GatewayAnswer> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== null) params.set(k, String(v));
    }
    const qs = params.toString();
    const base = withoutTrailingSlashes(this.baseUrl);
    const res = await this.fetcher.get(`${base}${route}${qs ? `?${qs}` : ''}`);
    let body: any = null;
    try {
      body = JSON.parse(bodyText(res));
    } catch {
      body = null;
    }
    if (res.status === 409 && body?.error?.code === 'height_gone') {
      throw new HeightGoneError(`${route}: the pinned height is gone`);
    }
    if (res.status === 404) {
      const message = String(body?.error?.message ?? '').toLowerCase();
      return { status: 404, noSuchRoute: message.includes('no such route') };
    }
    if (res.status !== 200) {
      throw new TdhChainSourceError(`${route}: ${refusal(res.status, body)}`);
    }
    if (body?.data === undefined) {
      throw new TdhChainSourceError(`${route}: the answer has no data`);
    }
    return { status: 200, read: body.read, data: body.data, next: body.next };
  }

  private remember(answer: GatewayAnswer): TdhChainDayInfo {
    const info = decodeTdhDay(answer.data, answer.read);
    this.days.set(info.header.cycleDay, {
      header: info.header,
      pin: info.apply.finalizedHeight
    });
    return info;
  }

  async latestDay(): Promise<TdhChainDayInfo | null> {
    const answer = await this.get('/v1/tdh');
    // No day applied yet: a 404 for the day, or no data.
    return noDay('/v1/tdh', answer) ? null : this.remember(answer);
  }

  async day(cycleDay: number): Promise<TdhChainDayInfo | null> {
    const route = `/v1/tdh/days/${cycleDay}`;
    const answer = await this.get(route);
    if (noDay(route, answer)) return null;
    const info = this.remember(answer);
    if (info.header.cycleDay !== cycleDay) {
      throw new TdhChainSourceError(
        `/v1/tdh/days/${cycleDay} answered day ${info.header.cycleDay}`
      );
    }
    return info;
  }

  /** The day's record and pin, read when not yet known. */
  private async known(cycleDay: number): Promise<KnownDay> {
    if (!this.days.has(cycleDay) && !(await this.day(cycleDay))) {
      throw new TdhChainSourceError(`the gateway holds no day ${cycleDay}`);
    }
    return this.days.get(cycleDay)!;
  }

  /**
   * Every chunk of a list at one pin. Null when the token list isn't
   * served; a wallet list, or any list's later chunk, that is gone throws
   * `ListGoneError` so the list is read again at a fresh pin.
   */
  private async chunks(
    route: string,
    kind: 'wallets' | 'tokens',
    pin: number | null
  ): Promise<any[] | null> {
    const out: any[] = [];
    let after: string | null = null;
    for (let n = 0; n < MAX_CHUNKS; n++) {
      const answer = await this.get(route, {
        after,
        limit: this.pageSize,
        height: pin
      });
      if (answer.status === 404) {
        // A release without the token route: no token list.
        if (kind === 'tokens' && answer.noSuchRoute) return null;
        if (answer.noSuchRoute) {
          throw new TdhGatewayRouteError(
            `${route}: the gateway has no such route`
          );
        }
        throw new ListGoneError(
          n === 0
            ? `${route}: the gateway holds no list for the day`
            : `${route}: chunk ${n + 1} is gone`
        );
      }
      if (answer.data === null) {
        throw new TdhChainSourceError(`${route}: a chunk with no data`);
      }
      out.push(answer.data);
      if (answer.next === null || answer.next === undefined) return out;
      if (typeof answer.next !== 'string' || answer.next === after) {
        throw new TdhChainSourceError(`${route}: a cursor that doesn't move`);
      }
      after = answer.next;
    }
    throw new TdhChainSourceError(`${route}: more than ${MAX_CHUNKS} chunks`);
  }

  /** A list read at the day's pin, again at a fresh pin if it is gone. */
  private async list<T>(
    cycleDay: number,
    kind: 'wallets' | 'tokens',
    check: (chunks: any[], header: TdhDayHeader) => T[]
  ): Promise<T[] | null> {
    for (let attempt = 1; ; attempt++) {
      const { header, pin } = await this.known(cycleDay);
      try {
        const chunks = await this.chunks(
          `/v1/tdh/days/${cycleDay}/${kind}`,
          kind,
          pin
        );
        if (attempt > 1) {
          logger.info(
            `[DAY ${cycleDay}] [${kind.toUpperCase()}] [READ ON TRY ${attempt} OF ${MAX_PINS}]`
          );
        }
        return chunks === null ? null : check(chunks, header);
      } catch (e) {
        const gone = e instanceof HeightGoneError || e instanceof ListGoneError;
        if (!gone) throw e;
        logger.warn(
          `[DAY ${cycleDay}] [${kind.toUpperCase()}] [TRY ${attempt} OF ${MAX_PINS}] [${(e as Error).message}]`
        );
        if (attempt >= MAX_PINS) {
          // The last answer wins: no token list, or no wallet list (thrown).
          if (kind === 'tokens' && e instanceof ListGoneError) return null;
          throw e;
        }
        this.days.delete(cycleDay);
      }
    }
  }

  async walletLeaves(cycleDay: number): Promise<TdhWalletLeaf[]> {
    const leaves = await this.list(cycleDay, 'wallets', (chunks, h) => {
      chunks.forEach((chunk) =>
        checkChunk(cycleDay, 'wallet', chunk, {
          day: cycleDay,
          walletRoot: h.walletRoot,
          walletCount: h.walletCount,
          identityCount: h.identityCount
        })
      );
      const rows = chunks.flatMap((chunk) => decodeWalletRows(chunk.rows));
      checkRows(cycleDay, 'wallet', rows.length, h.walletCount);
      if (walletRoot(rows) !== h.walletRoot) {
        throw new TdhChainShapeError(
          `day ${cycleDay}: the wallet rows don't rebuild the day's walletRoot`
        );
      }
      return rows;
    });
    // `chunks` returns null only for tokens.
    return leaves!;
  }

  /**
   * The token list, or null: not served, or in an answer the client can't
   * read or check (logged). Until the route exists its shape is a guess, so
   * such an answer leaves the day without a token list rather than failing
   * the day's read.
   */
  async tokenLeaves(cycleDay: number): Promise<TdhTokenLeaf[] | null> {
    try {
      return await this.readTokenLeaves(cycleDay);
    } catch (e) {
      if (!(e instanceof TdhChainShapeError)) throw e;
      logger.warn(
        `[DAY ${cycleDay}] [NO TOKEN LIST] [the token answer can't be read: ${e.message}]`
      );
      return null;
    }
  }

  private readTokenLeaves(cycleDay: number): Promise<TdhTokenLeaf[] | null> {
    return this.list(cycleDay, 'tokens', (chunks, h) => {
      chunks.forEach((chunk) =>
        checkChunk(cycleDay, 'token', chunk, {
          day: cycleDay,
          tokenRoot: h.tokenRoot,
          tokenCount: h.tokenCount
        })
      );
      const rows = chunks.flatMap((chunk) => decodeTokenRows(chunk.rows));
      checkRows(cycleDay, 'token', rows.length, h.tokenCount);
      if (tokenRoot(rows) !== h.tokenRoot) {
        throw new TdhChainShapeError(
          `day ${cycleDay}: the token rows don't rebuild the day's tokenRoot`
        );
      }
      return rows;
    });
  }
}

/** Every chunk names the day, its root and its counts. */
function checkChunk(
  cycleDay: number,
  kind: string,
  chunk: any,
  expected: Record<string, string | number>
): void {
  for (const [key, want] of Object.entries(expected)) {
    const got =
      typeof want === 'number' ? jsonUint(chunk, key) : jsonHash(chunk, key);
    if (got !== want) {
      throw new TdhChainShapeError(
        `day ${cycleDay}: a ${kind} chunk says ${key} ${got}, the day ${want}`
      );
    }
  }
}

/**
 * Why the gateway refused, in its words. A node answers `{ error: { code,
 * message } }`; the gateway itself, while no node serves, answers 503
 * `{ error: "nodes_unavailable", message }`.
 */
function refusal(status: number, body: any): string {
  const error = body?.error;
  if (typeof error === 'string') {
    return body?.message ? `${error}: ${body.message}` : error;
  }
  if (error && typeof error === 'object') {
    return [error.code, error.message].filter(Boolean).join(': ');
  }
  return `HTTP ${status}`;
}

/** No day: a 404 for the day, or no data. A missing route throws. */
function noDay(route: string, answer: GatewayAnswer): boolean {
  if (answer.status === 404 && answer.noSuchRoute) {
    throw new TdhGatewayRouteError(
      `${route}: the gateway has no such route; check TDH_CHAIN_GATEWAY_URL`
    );
  }
  return answer.status === 404 || answer.data === null;
}

function checkRows(
  cycleDay: number,
  kind: string,
  rows: number,
  count: number
): void {
  if (rows !== count) {
    throw new TdhChainShapeError(
      `day ${cycleDay}: ${rows} ${kind} rows, the day says ${count}`
    );
  }
}

/* ---------- day files ---------- */

export function walletDayFileName(cycleDay: number): string {
  return `tdh-chain-${dateOfCycleDay(cycleDay)}-wallets.csv`;
}

export function tokenDayFileName(cycleDay: number): string {
  return `tdh-chain-${dateOfCycleDay(cycleDay)}-tokens.csv`;
}

/**
 * Days from a folder of day files (`tdh-day-file.ts`): fixtures, a
 * validator's export converted to day files, or the site's published files.
 */
export class FileTdhChainSource implements TdhChainSource {
  private readonly cache = new Map<number, TdhChainDay>();

  constructor(private readonly dir: string) {}

  private async load(cycleDay: number): Promise<TdhChainDay | null> {
    const cached = this.cache.get(cycleDay);
    if (cached) return cached;
    let wallets: string;
    try {
      wallets = await fs.readFile(
        path.join(this.dir, walletDayFileName(cycleDay)),
        'utf8'
      );
    } catch {
      return null;
    }
    let tokens: string | null = null;
    try {
      tokens = await fs.readFile(
        path.join(this.dir, tokenDayFileName(cycleDay)),
        'utf8'
      );
    } catch {
      tokens = null;
    }
    const day = parseDayFiles(wallets, tokens);
    if (day.header.cycleDay !== cycleDay) {
      throw new TdhChainSourceError(
        `${walletDayFileName(cycleDay)} holds cycle day ${day.header.cycleDay}`
      );
    }
    this.cache.set(cycleDay, day);
    return day;
  }

  async latestDay(): Promise<TdhChainDayInfo | null> {
    const names = await fs.readdir(this.dir);
    const days = names
      .map((n) => /^tdh-chain-(\d{4})(\d{2})(\d{2})-wallets\.csv$/.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000)
      .sort((a, b) => b - a);
    return days.length ? this.day(days[0]) : null;
  }

  async day(cycleDay: number): Promise<TdhChainDayInfo | null> {
    const day = await this.load(cycleDay);
    return day ? { header: day.header, apply: day.apply } : null;
  }

  async walletLeaves(cycleDay: number): Promise<TdhWalletLeaf[]> {
    const day = await this.load(cycleDay);
    if (!day) throw new TdhChainSourceError(`no day file for ${cycleDay}`);
    return day.walletLeaves.slice();
  }

  async tokenLeaves(cycleDay: number): Promise<TdhTokenLeaf[] | null> {
    const day = await this.load(cycleDay);
    if (!day) throw new TdhChainSourceError(`no day file for ${cycleDay}`);
    return day.tokenLeaves ? day.tokenLeaves.slice() : null;
  }
}
