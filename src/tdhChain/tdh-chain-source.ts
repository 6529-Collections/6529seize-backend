import { promises as fs } from 'fs';
import * as path from 'path';
import { tokenRoot, walletRoot } from './p28';
import { bodyText, RateLimitedFetcher } from './rate-limited-fetcher';
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
    this.name = 'TdhChainSourceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/* ---------- decoding the gateway's answers ---------- */

/**
 * A whole number. The gateway sends counts and heights as JSON numbers and
 * TDH values as decimal strings; every value must be below 2^53.
 */
function jsonUint(obj: any, key: string): number {
  const v = obj?.[key];
  const n = typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    throw new TdhChainSourceError(`${key}: ${JSON.stringify(v)} is not a uint`);
  }
  return n;
}

function jsonHex(obj: any, key: string, bytes: number, what: string): string {
  const v = obj?.[key];
  const pattern = new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`);
  if (typeof v !== 'string' || !pattern.test(v)) {
    throw new TdhChainSourceError(
      `${key}: ${JSON.stringify(v)} is not ${what}`
    );
  }
  return v.toLowerCase();
}

const jsonHash = (obj: any, key: string) => jsonHex(obj, key, 32, 'a bytes32');
const jsonAddress = (obj: any, key: string) =>
  jsonHex(obj, key, 20, 'an address');

function jsonDecimal(obj: any, key: string): string {
  const v = obj?.[key];
  if (typeof v !== 'string' || !/^(0|[1-9]\d*)$/.test(v)) {
    throw new TdhChainSourceError(
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
    throw new TdhChainSourceError('a wallet list chunk has no rows');
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
export function decodeTokenRows(rows: unknown): TdhTokenLeaf[] {
  if (!Array.isArray(rows)) {
    throw new TdhChainSourceError('a token list chunk has no rows');
  }
  return rows.map((r) => ({
    cid: jsonHash(r, 'cid'),
    contract: jsonAddress(r, 'contract'),
    tokenId: jsonDecimal(r, 'tokenId'),
    tokenTdh: jsonUint(r, 'tokenTdh')
  }));
}

/* ---------- the gateway ---------- */

/** Rows asked for per chunk: the gateway's cap. */
export const GATEWAY_PAGE_SIZE = 5000;
/** Chunks of one list before the read gives up on a looping cursor. */
const MAX_CHUNKS = 1000;
/** Pins tried when the gateway no longer holds a pinned height. */
const MAX_PINS = 3;

class HeightGoneError extends TdhChainSourceError {}

interface GatewayAnswer {
  readonly status: number;
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
 *   same chunks, with `tokenRoot` and `tokenCount`. Not served yet: a 404
 *   reads as no token list.
 *
 * Every answer is `{ read, data, next }`. A day's lists are read pinned at
 * the finalized height its record was read at (`?height=`), so record and
 * chunks come from one state. If the gateway no longer holds that height
 * (409 `height_gone`), the record and the list are read again from the
 * start at a fresh pin. Each list is checked against its day: every chunk
 * names the day's root and counts, and the root rebuilt from all its rows
 * must equal the day's.
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
    const base = this.baseUrl.replace(/\/+$/, '');
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
    if (res.status === 404) return { status: 404 };
    if (res.status !== 200) {
      const why = body?.error
        ? `${body.error.code}: ${body.error.message}`
        : `HTTP ${res.status}`;
      throw new TdhChainSourceError(`${route}: ${why}`);
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
    // No day applied yet: a 404, or no data.
    return answer.status === 404 || answer.data === null
      ? null
      : this.remember(answer);
  }

  async day(cycleDay: number): Promise<TdhChainDayInfo | null> {
    const answer = await this.get(`/v1/tdh/days/${cycleDay}`);
    if (answer.status === 404 || answer.data === null) return null;
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

  /** Every chunk of a list at one pin, or null on a 404. */
  private async chunks(
    route: string,
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
        if (n === 0) return null;
        throw new TdhChainSourceError(`${route}: chunk ${n + 1} is gone`);
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
          pin
        );
        return chunks === null ? null : check(chunks, header);
      } catch (e) {
        if (!(e instanceof HeightGoneError) || attempt >= MAX_PINS) throw e;
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
        throw new TdhChainSourceError(
          `day ${cycleDay}: the wallet rows don't rebuild the day's walletRoot`
        );
      }
      return rows;
    });
    if (leaves === null) {
      throw new TdhChainSourceError(
        `the gateway holds no wallet list for day ${cycleDay}`
      );
    }
    return leaves;
  }

  tokenLeaves(cycleDay: number): Promise<TdhTokenLeaf[] | null> {
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
        throw new TdhChainSourceError(
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
      throw new TdhChainSourceError(
        `day ${cycleDay}: a ${kind} chunk says ${key} ${got}, the day ${want}`
      );
    }
  }
}

function checkRows(
  cycleDay: number,
  kind: string,
  rows: number,
  count: number
): void {
  if (rows !== count) {
    throw new TdhChainSourceError(
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
