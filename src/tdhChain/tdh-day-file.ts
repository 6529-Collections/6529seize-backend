import { csvField, parseCsv } from './csv';
import { consolidationKeyOf, isAddress, isBytes32 } from './p28';
import {
  TdhChainDay,
  TdhDayApply,
  TdhDayHeader,
  TdhTokenLeaf,
  TdhWalletLeaf
} from './tdh-chain.types';

/**
 * The day files: one TDH day from the 6529 chain as two CSV files, the open
 * data the site publishes each day and the chain side of the compare tool's
 * fixtures.
 *
 * Each file starts with `# key: value` lines carrying the day's header (and
 * the apply block when known), then a CSV header and one row per leaf:
 *
 * - wallets: `wallet,cid,identity_tdh,wallet_tdh,wallet_count,consolidation_key`,
 *   ascending by wallet (P28 4.3). `consolidation_key` is the cluster's
 *   wallets joined by `-`, for readers who join with 6529.io's tables; a
 *   reader recomputes it rather than trusting it.
 * - tokens: `cid,contract,token_id,token_tdh`, ascending by (cid, contract,
 *   token id) (P28 4.12).
 *
 * The bytes are a function of the day: LF line endings, fixed key order, no
 * spaces around commas. So a rebuild writes the same file and the same CID.
 */

export const WALLET_FILE_COLUMNS = [
  'wallet',
  'cid',
  'identity_tdh',
  'wallet_tdh',
  'wallet_count',
  'consolidation_key'
] as const;

export const TOKEN_FILE_COLUMNS = [
  'cid',
  'contract',
  'token_id',
  'token_tdh'
] as const;

export class TdhDayFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TdhDayFileError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const HEADER_KEYS: readonly (keyof TdhDayHeader)[] = [
  'cycleDay',
  'boundary',
  'tdhRuleId',
  'cutoffNumber',
  'cutoffHash',
  'cutoffTimestamp',
  'walletRoot',
  'walletCount',
  'identityCount',
  'totalTdh',
  'tokenRoot',
  'tokenCount'
];
const APPLY_KEYS: readonly (keyof TdhDayApply)[] = [
  'applyHeight',
  'applyBlockHash',
  'applyTimeMs',
  'finalizedHeight'
];
const HASH_KEYS = new Set<string>([
  'tdhRuleId',
  'cutoffHash',
  'walletRoot',
  'tokenRoot',
  'applyBlockHash'
]);

function snake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** A non-negative safe integer written as plain digits. */
export function parseUintText(text: string, what: string): number {
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new TdhDayFileError(
      `${what}: ${JSON.stringify(text)} is not an unsigned integer`
    );
  }
  const v = Number(text);
  if (!Number.isSafeInteger(v)) {
    throw new TdhDayFileError(`${what}: ${text} is above 2^53 - 1`);
  }
  return v;
}

function parseUint256Text(text: string, what: string): string {
  if (!/^(0|[1-9]\d*)$/.test(text) || text.length > 78) {
    throw new TdhDayFileError(
      `${what}: ${JSON.stringify(text)} is not a uint256`
    );
  }
  if (BigInt(text) >= BigInt(1) << BigInt(256)) {
    throw new TdhDayFileError(`${what}: ${text} is outside uint256`);
  }
  return text;
}

function headerLines(
  title: string,
  header: TdhDayHeader,
  apply: TdhDayApply
): string[] {
  const lines = [`# ${title}`];
  for (const k of HEADER_KEYS) lines.push(`# ${snake(k)}: ${header[k]}`);
  for (const k of APPLY_KEYS) {
    const v = apply[k];
    if (v !== null) lines.push(`# ${snake(k)}: ${v}`);
  }
  return lines;
}

/** Each wallet's cluster members, by cid, ascending. */
export function clusterWalletsByCid(
  leaves: readonly TdhWalletLeaf[]
): Map<string, string[]> {
  const byCid = new Map<string, string[]>();
  for (const leaf of leaves) {
    const members = byCid.get(leaf.cid);
    if (members) members.push(leaf.wallet);
    else byCid.set(leaf.cid, [leaf.wallet]);
  }
  return byCid;
}

export function formatWalletDayFile(day: TdhChainDay): string {
  const clusters = clusterWalletsByCid(day.walletLeaves);
  const lines = headerLines(
    '6529 TDH day from the 6529 chain: wallet list (P28 4.3)',
    day.header,
    day.apply
  );
  lines.push(WALLET_FILE_COLUMNS.join(','));
  for (const leaf of day.walletLeaves) {
    lines.push(
      [
        leaf.wallet,
        leaf.cid,
        String(leaf.identityTdh),
        String(leaf.walletTdh),
        String(leaf.walletCount),
        csvField(consolidationKeyOf(clusters.get(leaf.cid) ?? [leaf.wallet]))
      ].join(',')
    );
  }
  return lines.join('\n') + '\n';
}

export function formatTokenDayFile(day: TdhChainDay): string {
  if (!day.tokenLeaves) {
    throw new TdhDayFileError('the day has no token list');
  }
  const lines = headerLines(
    '6529 TDH day from the 6529 chain: token list (P28 4.12)',
    day.header,
    day.apply
  );
  lines.push(TOKEN_FILE_COLUMNS.join(','));
  for (const t of day.tokenLeaves) {
    lines.push([t.cid, t.contract, t.tokenId, String(t.tokenTdh)].join(','));
  }
  return lines.join('\n') + '\n';
}

interface ParsedFile {
  readonly header: TdhDayHeader;
  readonly apply: TdhDayApply;
  readonly columns: string[];
  readonly rows: string[][];
}

function parseFile(text: string, file: string): ParsedFile {
  const lines = text.split('\n');
  const meta = new Map<string, string>();
  let first = 0;
  for (; first < lines.length && lines[first].startsWith('#'); first++) {
    const m = /^# ([a-z_]+): (\S+)$/.exec(lines[first]);
    if (!m) continue; // the title line
    if (meta.has(m[1])) {
      throw new TdhDayFileError(`${file}: ${m[1]} given twice`);
    }
    meta.set(m[1], m[2]);
  }
  const value = (k: string, required: boolean): string | null => {
    const v = meta.get(snake(k)) ?? null;
    if (v === null && required) {
      throw new TdhDayFileError(`${file}: missing # ${snake(k)}`);
    }
    if (v !== null && HASH_KEYS.has(k) && !isBytes32(v)) {
      throw new TdhDayFileError(
        `${file}: ${snake(k)} is not a lowercase bytes32`
      );
    }
    return v;
  };
  const header: Record<string, string | number> = {};
  for (const k of HEADER_KEYS) {
    const v = value(k, true)!;
    header[k] = HASH_KEYS.has(k) ? v : parseUintText(v, `${file} ${snake(k)}`);
  }
  const apply: Record<string, string | number | null> = {};
  for (const k of APPLY_KEYS) {
    const v = value(k, false);
    apply[k] =
      v === null
        ? null
        : HASH_KEYS.has(k)
          ? v
          : parseUintText(v, `${file} ${snake(k)}`);
  }
  const records = parseCsv(lines.slice(first).join('\n'));
  if (records.length === 0) {
    throw new TdhDayFileError(`${file}: no column header`);
  }
  return {
    header: header as unknown as TdhDayHeader,
    apply: apply as unknown as TdhDayApply,
    columns: records[0],
    rows: records.slice(1)
  };
}

function requireColumns(
  file: string,
  columns: string[],
  expected: readonly string[]
) {
  if (columns.join(',') !== expected.join(',')) {
    throw new TdhDayFileError(
      `${file}: columns ${columns.join(',')}, expected ${expected.join(',')}`
    );
  }
}

function sameHeader(a: TdhDayHeader, b: TdhDayHeader): boolean {
  return HEADER_KEYS.every((k) => a[k] === b[k]);
}

/**
 * Read a day from its wallet file and, when there is one, its token file.
 * The values are parsed strictly; whether they hang together (order, roots,
 * clusters, totals) is `verifyChainDay`'s job.
 */
export function parseDayFiles(
  walletsText: string,
  tokensText: string | null
): TdhChainDay {
  const wallets = parseFile(walletsText, 'wallet file');
  requireColumns('wallet file', wallets.columns, WALLET_FILE_COLUMNS);
  const walletLeaves = wallets.rows.map((r, i): TdhWalletLeaf => {
    const at = `wallet file row ${i + 1}`;
    if (r.length !== WALLET_FILE_COLUMNS.length) {
      throw new TdhDayFileError(`${at}: ${r.length} fields`);
    }
    if (!isAddress(r[0])) throw new TdhDayFileError(`${at}: wallet`);
    if (!isBytes32(r[1])) throw new TdhDayFileError(`${at}: cid`);
    const walletCount = parseUintText(r[4], `${at} wallet_count`);
    if (walletCount < 1 || walletCount > 255) {
      throw new TdhDayFileError(`${at}: wallet_count ${walletCount}`);
    }
    return {
      wallet: r[0],
      cid: r[1],
      identityTdh: parseUintText(r[2], `${at} identity_tdh`),
      walletTdh: parseUintText(r[3], `${at} wallet_tdh`),
      walletCount
    };
  });
  let tokenLeaves: TdhTokenLeaf[] | null = null;
  if (tokensText !== null) {
    const tokens = parseFile(tokensText, 'token file');
    requireColumns('token file', tokens.columns, TOKEN_FILE_COLUMNS);
    if (!sameHeader(wallets.header, tokens.header)) {
      throw new TdhDayFileError('the two files carry different day headers');
    }
    tokenLeaves = tokens.rows.map((r, i): TdhTokenLeaf => {
      const at = `token file row ${i + 1}`;
      if (r.length !== TOKEN_FILE_COLUMNS.length) {
        throw new TdhDayFileError(`${at}: ${r.length} fields`);
      }
      if (!isBytes32(r[0])) throw new TdhDayFileError(`${at}: cid`);
      if (!isAddress(r[1])) throw new TdhDayFileError(`${at}: contract`);
      return {
        cid: r[0],
        contract: r[1],
        tokenId: parseUint256Text(r[2], `${at} token_id`),
        tokenTdh: parseUintText(r[3], `${at} token_tdh`)
      };
    });
  }
  return {
    header: wallets.header,
    apply: wallets.apply,
    walletLeaves,
    tokenLeaves
  };
}
