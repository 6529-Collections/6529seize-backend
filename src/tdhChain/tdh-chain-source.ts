import { promises as fs } from 'fs';
import * as path from 'path';
import { hexlify } from 'ethers';
import { bodyJson, RateLimitedFetcher } from './rate-limited-fetcher';
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
 * Where the site reads the chain's TDH days. Named after the design's
 * gateway calls (DESIGN.md section 3), so moving onto the identity lead's
 * shared gateway client is a mechanical swap:
 *
 * - G1 `latestDay`, `day`: a day's TdhDay record and where it applied;
 * - G2 `walletLeaves`: the day's wallet list (P28 4.3);
 * - G3 `tokenLeaves`: the day's token list (P28 4.12), null when not served.
 *
 * The answers are checked by `verifyChainDay` before use; a source only
 * fetches and decodes.
 */
export interface TdhChainSource {
  /** G1: the newest applied day whose apply block is final, or null. */
  latestDay(): Promise<TdhChainDayInfo | null>;
  /** G1: one applied day, or null when the chain has none by that number. */
  day(cycleDay: number): Promise<TdhChainDayInfo | null>;
  /** G2. */
  walletLeaves(cycleDay: number): Promise<TdhWalletLeaf[]>;
  /** G3: null when the source doesn't serve token lists. */
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

/** P28 4.3's leaf in CE: address 20, cid 32, two uint64 BE, uint8. */
export const WALLET_LEAF_BYTES = 69;
/** P28 4.12's leaf in CE: cid 32, contract 20, uint256 BE, uint64 BE. */
export const TOKEN_LEAF_BYTES = 92;

function readUint(bytes: Uint8Array, offset: number, length: number): bigint {
  let v = BigInt(0);
  for (let i = 0; i < length; i++) {
    v = (v << BigInt(8)) | BigInt(bytes[offset + i]);
  }
  return v;
}

function safeNumber(v: bigint, what: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TdhChainSourceError(`${what} ${v} is above 2^53 - 1`);
  }
  return Number(v);
}

export function decodeWalletLeaves(bytes: Uint8Array): TdhWalletLeaf[] {
  if (bytes.length % WALLET_LEAF_BYTES !== 0) {
    throw new TdhChainSourceError(
      `${bytes.length} bytes is not a whole number of wallet leaves`
    );
  }
  const leaves: TdhWalletLeaf[] = [];
  for (let o = 0; o < bytes.length; o += WALLET_LEAF_BYTES) {
    leaves.push({
      wallet: hexlify(bytes.subarray(o, o + 20)),
      cid: hexlify(bytes.subarray(o + 20, o + 52)),
      identityTdh: safeNumber(readUint(bytes, o + 52, 8), 'identityTDH'),
      walletTdh: safeNumber(readUint(bytes, o + 60, 8), 'walletTDH'),
      walletCount: bytes[o + 68]
    });
  }
  return leaves;
}

export function decodeTokenLeaves(bytes: Uint8Array): TdhTokenLeaf[] {
  if (bytes.length % TOKEN_LEAF_BYTES !== 0) {
    throw new TdhChainSourceError(
      `${bytes.length} bytes is not a whole number of token leaves`
    );
  }
  const leaves: TdhTokenLeaf[] = [];
  for (let o = 0; o < bytes.length; o += TOKEN_LEAF_BYTES) {
    leaves.push({
      cid: hexlify(bytes.subarray(o, o + 32)),
      contract: hexlify(bytes.subarray(o + 32, o + 52)),
      tokenId: readUint(bytes, o + 52, 32).toString(),
      tokenTdh: safeNumber(readUint(bytes, o + 84, 8), 'tokenTDH')
    });
  }
  return leaves;
}

function jsonUint(obj: any, key: string): number {
  const v = obj?.[key];
  const n = typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    throw new TdhChainSourceError(`${key}: ${JSON.stringify(v)} is not a uint`);
  }
  return n;
}

function jsonHash(obj: any, key: string): string {
  const v = obj?.[key];
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new TdhChainSourceError(
      `${key}: ${JSON.stringify(v)} is not a bytes32`
    );
  }
  return v.toLowerCase();
}

function optional<T>(obj: any, key: string, read: (o: any, k: string) => T) {
  return obj?.[key] === undefined || obj?.[key] === null
    ? null
    : read(obj, key);
}

/** A G1 answer: the TdhDay fields in snake case, plus where it applied. */
export function decodeDayInfo(json: any): TdhChainDayInfo {
  const header: TdhDayHeader = {
    cycleDay: jsonUint(json, 'cycle_day'),
    boundary: jsonUint(json, 'boundary'),
    tdhRuleId: jsonHash(json, 'tdh_rule_id'),
    cutoffNumber: jsonUint(json, 'cutoff_number'),
    cutoffHash: jsonHash(json, 'cutoff_hash'),
    cutoffTimestamp: jsonUint(json, 'cutoff_timestamp'),
    walletRoot: jsonHash(json, 'wallet_root'),
    walletCount: jsonUint(json, 'wallet_count'),
    identityCount: jsonUint(json, 'identity_count'),
    totalTdh: jsonUint(json, 'total_tdh'),
    tokenRoot: jsonHash(json, 'token_root'),
    tokenCount: jsonUint(json, 'token_count')
  };
  const apply: TdhDayApply = {
    applyHeight: optional(json, 'apply_height', jsonUint),
    applyBlockHash: optional(json, 'apply_block_hash', jsonHash),
    applyTimeMs: optional(json, 'apply_time_ms', jsonUint),
    finalizedHeight: optional(json, 'finalized_height', jsonUint)
  };
  return { header, apply };
}

/* ---------- the gateway ---------- */

/**
 * The gateway's TDH reads, as DESIGN.md section 3 asks for them:
 *
 * - `GET {base}/v1/tdh/days/latest` and `GET {base}/v1/tdh/days/{cycleDay}`:
 *   JSON, the TdhDay fields in snake case plus `apply_height`,
 *   `apply_block_hash`, `apply_time_ms`, `finalized_height`; 404 for no day;
 * - `GET {base}/v1/tdh/days/{cycleDay}/wallets`: the wallet leaves in CE,
 *   69 bytes each, ascending;
 * - `GET {base}/v1/tdh/days/{cycleDay}/tokens`: the token leaves in CE,
 *   92 bytes each; 404 while tokens aren't served.
 *
 * The wire format is provisional until lane 7 publishes theirs; only the
 * decoders above change if it differs.
 */
export class GatewayTdhChainSource implements TdhChainSource {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: RateLimitedFetcher
  ) {}

  private url(p: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/v1/tdh/days/${p}`;
  }

  private async info(p: string): Promise<TdhChainDayInfo | null> {
    const res = await this.fetcher.get(this.url(p));
    if (res.status === 404) return null;
    return decodeDayInfo(bodyJson(res));
  }

  latestDay(): Promise<TdhChainDayInfo | null> {
    return this.info('latest');
  }

  day(cycleDay: number): Promise<TdhChainDayInfo | null> {
    return this.info(String(cycleDay));
  }

  async walletLeaves(cycleDay: number): Promise<TdhWalletLeaf[]> {
    const res = await this.fetcher.get(this.url(`${cycleDay}/wallets`));
    if (res.status !== 200) {
      throw new TdhChainSourceError(
        `wallet list of ${cycleDay}: HTTP ${res.status}`
      );
    }
    return decodeWalletLeaves(res.body);
  }

  async tokenLeaves(cycleDay: number): Promise<TdhTokenLeaf[] | null> {
    const res = await this.fetcher.get(this.url(`${cycleDay}/tokens`));
    if (res.status === 404) return null;
    if (res.status !== 200) {
      throw new TdhChainSourceError(
        `token list of ${cycleDay}: HTTP ${res.status}`
      );
    }
    return decodeTokenLeaves(res.body);
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
