import { createHash } from 'node:crypto';

/**
 * The switch-on record of TDH-only identities: every identities row with no
 * handle whose profile id is not a chain principal, and those rows' address
 * keys, as they stood before the identity mirror's first change. Their
 * profile ids were issued at random before the switch-on, so a rebuild
 * can't derive them; it reads them from this record, pinned by sha256.
 *
 * The same bytes come from the mirror's own snapshot or from the team's
 * read-only queries (`mysql --batch --raw`), so one parser reads both:
 *
 * - two files, tab-separated, UTF-8 without a BOM, LF line ends and a final
 *   LF, each with one header line;
 * - identities: `consolidation_key profile_id primary_address tdh rep cic
 *   level_raw`, ascending by consolidation_key;
 * - address keys: `address consolidation_key`, ascending by address;
 * - keys and addresses lowercase as stored, numbers as decimal integers, and
 *   a NULL as `NULL` (only profile_id can be NULL);
 * - ascending means by UTF-16 code unit, which for these values (lowercase
 *   hex and `-`) is byte order and the database's order.
 */

export const TDH_ONLY_IDENTITIES_COLUMNS = [
  'consolidation_key',
  'profile_id',
  'primary_address',
  'tdh',
  'rep',
  'cic',
  'level_raw'
] as const;

export const TDH_ONLY_ADDRESS_KEYS_COLUMNS = [
  'address',
  'consolidation_key'
] as const;

export interface TdhOnlyIdentityRow {
  readonly consolidation_key: string;
  readonly profile_id: string | null;
  readonly primary_address: string;
  readonly tdh: number;
  readonly rep: number;
  readonly cic: number;
  readonly level_raw: number;
}

export interface TdhOnlyAddressKey {
  readonly address: string;
  readonly consolidation_key: string;
}

export interface TdhOnlyRecord {
  readonly rows: TdhOnlyIdentityRow[];
  readonly keys: TdhOnlyAddressKey[];
}

export interface FormattedTdhOnlyRecord {
  readonly identitiesTsv: string;
  readonly keysTsv: string;
  readonly identitiesSha256: string;
  readonly keysSha256: string;
}

/** A record that can't be trusted: the rebuild must not seed from it. */
export class TdhOnlyRecordError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'TdhOnlyRecordError';
  }
}

const NULL = 'NULL';
const BOM = 0xfeff;
const WALLET = /^0x[0-9a-f]{40}$/;
const INTEGER = /^-?(0|[1-9]\d*)$/;
const PROFILE_ID = /^[0-9A-Za-z_-]{1,50}$/;

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : Number(a > b));

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function fail(message: string): never {
  throw new TdhOnlyRecordError(message);
}

function checkKey(key: string, where: string): void {
  const wallets = key.split('-');
  if (!wallets.every((w) => WALLET.test(w))) {
    fail(
      `${where}: consolidation key ${JSON.stringify(key)} is not wallets joined by '-'`
    );
  }
}

function checkWallet(wallet: string, where: string): void {
  if (!WALLET.test(wallet)) {
    fail(`${where}: ${JSON.stringify(wallet)} is not a lowercase wallet`);
  }
}

function checkProfileId(id: string | null, where: string): void {
  if (id !== null && (id === NULL || !PROFILE_ID.test(id))) {
    fail(`${where}: profile id ${JSON.stringify(id)} is not a profile id`);
  }
}

function checkInteger(value: number, column: string, where: string): void {
  if (!Number.isSafeInteger(value)) {
    fail(`${where}: ${column} ${value} is not a whole number`);
  }
}

function parseInteger(text: string, column: string, where: string): number {
  if (!INTEGER.test(text)) {
    fail(
      `${where}: ${column} ${JSON.stringify(text)} is not a decimal integer`
    );
  }
  const value = Number(text);
  checkInteger(value, column, where);
  return value;
}

function checkAscending(values: readonly string[], what: string): void {
  for (let i = 1; i < values.length; i++) {
    if (byCodeUnit(values[i - 1], values[i]) >= 0) {
      fail(
        `${what}: line ${i + 2} is not after line ${i + 1} (sorted, no repeats)`
      );
    }
  }
}

/**
 * The checks both directions share: lowercase keys and wallets, whole
 * numbers, unique primary addresses, and every address key on a recorded
 * row and inside that row's key.
 */
function checkRecord(
  rows: readonly TdhOnlyIdentityRow[],
  keys: readonly TdhOnlyAddressKey[]
): void {
  const primaries = new Set<string>();
  const rowKeys = new Set<string>();
  rows.forEach((row, i) => {
    const where = `identities row ${i + 1}`;
    checkKey(row.consolidation_key, where);
    checkProfileId(row.profile_id, where);
    checkWallet(row.primary_address, where);
    for (const column of ['tdh', 'rep', 'cic', 'level_raw'] as const) {
      checkInteger(row[column], column, where);
    }
    if (primaries.has(row.primary_address)) {
      fail(`${where}: primary address ${row.primary_address} repeats`);
    }
    primaries.add(row.primary_address);
    rowKeys.add(row.consolidation_key);
  });
  keys.forEach((key, i) => {
    const where = `address keys row ${i + 1}`;
    checkWallet(key.address, where);
    checkKey(key.consolidation_key, where);
    if (!rowKeys.has(key.consolidation_key)) {
      fail(`${where}: no identities row has key ${key.consolidation_key}`);
    }
    if (!key.consolidation_key.split('-').includes(key.address)) {
      fail(`${where}: ${key.address} is not a wallet of its key`);
    }
  });
}

function toTsv(header: readonly string[], lines: string[][]): string {
  return [header, ...lines].map((cells) => `${cells.join('\t')}\n`).join('');
}

/**
 * The record's two files and their sha256, from rows and keys in any order.
 * Throws a TdhOnlyRecordError on a value the format can't hold.
 */
export function formatTdhOnlyRecord(
  rows: readonly TdhOnlyIdentityRow[],
  keys: readonly TdhOnlyAddressKey[]
): FormattedTdhOnlyRecord {
  const sortedRows = [...rows].sort((a, b) =>
    byCodeUnit(a.consolidation_key, b.consolidation_key)
  );
  const sortedKeys = [...keys].sort((a, b) => byCodeUnit(a.address, b.address));
  checkRecord(sortedRows, sortedKeys);
  checkAscending(
    sortedRows.map((r) => r.consolidation_key),
    'identities'
  );
  checkAscending(
    sortedKeys.map((k) => k.address),
    'address keys'
  );
  const identitiesTsv = toTsv(
    TDH_ONLY_IDENTITIES_COLUMNS,
    sortedRows.map((r) => [
      r.consolidation_key,
      r.profile_id ?? NULL,
      r.primary_address,
      String(r.tdh),
      String(r.rep),
      String(r.cic),
      String(r.level_raw)
    ])
  );
  const keysTsv = toTsv(
    TDH_ONLY_ADDRESS_KEYS_COLUMNS,
    sortedKeys.map((k) => [k.address, k.consolidation_key])
  );
  return {
    identitiesTsv,
    keysTsv,
    identitiesSha256: sha256Hex(identitiesTsv),
    keysSha256: sha256Hex(keysTsv)
  };
}

function splitTsv(
  text: string,
  header: readonly string[],
  what: string
): string[][] {
  if (text.charCodeAt(0) === BOM)
    fail(`${what}: starts with a byte order mark`);
  if (text.includes('\r')) fail(`${what}: has a carriage return; LF only`);
  if (!text.endsWith('\n')) fail(`${what}: does not end with a line feed`);
  const lines = text.slice(0, -1).split('\n');
  if (lines[0] !== header.join('\t')) {
    fail(`${what}: the header is not ${header.join(' ')}`);
  }
  return lines.slice(1).map((line, i) => {
    const cells = line.split('\t');
    if (cells.length !== header.length) {
      fail(
        `${what}: line ${i + 2} has ${cells.length} fields, not ${header.length}`
      );
    }
    return cells;
  });
}

/**
 * Reads the record's two files, after checking each against its pinned
 * sha256, and checks everything the format promises. Throws a
 * TdhOnlyRecordError on the first thing that's off.
 */
export function parseTdhOnlyRecord(
  identitiesTsv: string,
  keysTsv: string,
  pins: { readonly identitiesSha256: string; readonly keysSha256: string }
): TdhOnlyRecord {
  if (sha256Hex(identitiesTsv) !== pins.identitiesSha256.toLowerCase()) {
    fail('identities: the sha256 does not match the pinned one');
  }
  if (sha256Hex(keysTsv) !== pins.keysSha256.toLowerCase()) {
    fail('address keys: the sha256 does not match the pinned one');
  }
  const rows = splitTsv(
    identitiesTsv,
    TDH_ONLY_IDENTITIES_COLUMNS,
    'identities'
  ).map((cells, i): TdhOnlyIdentityRow => {
    const where = `identities line ${i + 2}`;
    const [key, profileId, primary, tdh, rep, cic, levelRaw] = cells;
    return {
      consolidation_key: key,
      profile_id: profileId === NULL ? null : profileId,
      primary_address: primary,
      tdh: parseInteger(tdh, 'tdh', where),
      rep: parseInteger(rep, 'rep', where),
      cic: parseInteger(cic, 'cic', where),
      level_raw: parseInteger(levelRaw, 'level_raw', where)
    };
  });
  const keys = splitTsv(
    keysTsv,
    TDH_ONLY_ADDRESS_KEYS_COLUMNS,
    'address keys'
  ).map(
    ([address, key]): TdhOnlyAddressKey => ({ address, consolidation_key: key })
  );
  checkAscending(
    rows.map((r) => r.consolidation_key),
    'identities'
  );
  checkAscending(
    keys.map((k) => k.address),
    'address keys'
  );
  checkRecord(rows, keys);
  return { rows, keys };
}
