import { parseCsv } from './csv';
import { isAddress } from './p28';
import {
  SITE_COLLECTIONS,
  SiteDay,
  SiteDayBuilder,
  SiteDayError,
  SiteToken
} from './site-day';

/**
 * 6529.io's two daily TDH uploads (`tdh_upload.ts`; listed by the public
 * `/api/uploads` and `/api/consolidated_uploads`), read into a SiteDay.
 *
 * The rules follow the validator's compare crate (`crates/compare`,
 * upload.rs and number.rs), loosened in one way: a column this reader
 * doesn't use may be added or missing, and the report notes it. The columns
 * it uses must be there. `consolidation_display` can hold names and is never
 * read. The owner-balance columns (BUG-15: `total_balance`, `memes_balance`
 * and the rest) are not the day's values and are never read either.
 */

const WALLET_REQUIRED = [
  'wallet',
  'block',
  'date',
  'boosted_tdh',
  'boost',
  'memes',
  'gradients',
  'nextgen'
];
const CONSOLIDATED_REQUIRED = [
  'consolidation_key',
  'wallets',
  'block',
  'date',
  'boosted_tdh',
  'boost',
  'memes',
  'gradients',
  'nextgen'
];
/** The columns of 2026-10-14's uploads (compare crate, upload.rs). */
const KNOWN_COLUMNS = new Set([
  'wallet',
  'consolidation_key',
  'consolidation_display',
  'wallets',
  'block',
  'date',
  'total_balance',
  'boosted_tdh',
  'tdh_rank',
  'tdh',
  'tdh__raw',
  'boost',
  'memes_balance',
  'unique_memes',
  'memes_cards_sets',
  'memes_cards_sets_minus1',
  'memes_cards_sets_minus2',
  'genesis',
  'nakamoto',
  'boosted_memes_tdh',
  'memes_tdh',
  'memes_tdh__raw',
  'tdh_rank_memes',
  'memes',
  'gradients_balance',
  'boosted_gradients_tdh',
  'gradients_tdh',
  'gradients_tdh__raw',
  'tdh_rank_gradients',
  'gradients',
  'nextgen_balance',
  'boosted_nextgen_tdh',
  'nextgen_tdh',
  'nextgen_tdh__raw',
  'nextgen',
  'boost_breakdown'
]);

function uint(text: string, where: string): number {
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new SiteDayError(
      `${where}: ${JSON.stringify(text)} is not an unsigned integer`
    );
  }
  const v = Number(text);
  if (!Number.isSafeInteger(v)) {
    throw new SiteDayError(`${where}: ${text} is above 2^53 - 1`);
  }
  return v;
}

/** JavaScript's shortest form of a non-negative number, as the CSV has it. */
function decimal(text: string, where: string): number {
  if (!/^(0|[1-9]\d*)(\.\d*[1-9])?$/.test(text)) {
    throw new SiteDayError(
      `${where}: ${JSON.stringify(text)} is not a decimal`
    );
  }
  return Number(text);
}

function jsonNumber(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new SiteDayError(
      `${where}: ${JSON.stringify(v)} is not a non-negative number`
    );
  }
  return v;
}

function tokenId(v: unknown, where: string): string {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) {
    return String(v);
  }
  if (typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v)) return v;
  throw new SiteDayError(`${where}: token id ${JSON.stringify(v)}`);
}

function tokens(
  cell: string,
  collection: (typeof SITE_COLLECTIONS)[number],
  where: string
): SiteToken[] {
  let parsed: unknown;
  try {
    parsed = cell === '' ? [] : JSON.parse(cell);
  } catch {
    throw new SiteDayError(`${where}: ${collection} is not JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new SiteDayError(`${where}: ${collection} is not a list`);
  }
  return parsed.map((t: any, i: number) => {
    const at = `${where} ${collection}[${i}]`;
    if (t === null || typeof t !== 'object') {
      throw new SiteDayError(`${at}: not an object`);
    }
    return {
      collection,
      tokenId: tokenId(t.id, at),
      tdh: jsonNumber(t.tdh, `${at}.tdh`),
      balance: jsonNumber(t.balance, `${at}.balance`)
    };
  });
}

interface Table {
  readonly index: (name: string) => number;
  readonly rows: string[][];
}

function table(
  text: string,
  required: readonly string[],
  file: string,
  builder: SiteDayBuilder
): Table {
  const records = parseCsv(text);
  if (records.length === 0) throw new SiteDayError(`${file}: empty`);
  const columns = records[0];
  const positions = new Map<string, number>();
  columns.forEach((c, i) => {
    if (positions.has(c)) throw new SiteDayError(`${file}: column ${c} twice`);
    positions.set(c, i);
  });
  for (const c of required) {
    if (!positions.has(c)) throw new SiteDayError(`${file}: no ${c} column`);
  }
  const unknown = columns.filter((c) => !KNOWN_COLUMNS.has(c));
  if (unknown.length) {
    builder.note(
      `${file}: columns not in the 2026-10-14 layout: ${unknown.join(', ')}`
    );
  }
  const rows = records.slice(1);
  rows.forEach((r, i) => {
    if (r.length !== columns.length) {
      throw new SiteDayError(
        `${file} row ${i + 1}: ${r.length} fields, ${columns.length} columns`
      );
    }
  });
  return { index: (name) => positions.get(name)!, rows };
}

function rowTokens(t: Table, r: string[], where: string): SiteToken[] {
  return SITE_COLLECTIONS.flatMap((c) => tokens(r[t.index(c)], c, where));
}

export function siteDayFromUploads(
  walletCsv: string,
  consolidatedCsv: string
): SiteDay {
  const builder = new SiteDayBuilder();

  const w = table(walletCsv, WALLET_REQUIRED, 'wallet upload', builder);
  w.rows.forEach((r, i) => {
    const where = `wallet upload row ${i + 1}`;
    const wallet = r[w.index('wallet')].toLowerCase();
    if (!isAddress(wallet)) throw new SiteDayError(`${where}: wallet`);
    decimal(r[w.index('boost')], `${where} boost`);
    const held = rowTokens(w, r, where);
    builder.addWallet(
      uint(r[w.index('block')], `${where} block`),
      r[w.index('date')],
      {
        wallet,
        boostedTdh: uint(r[w.index('boosted_tdh')], `${where} boosted_tdh`),
        holds: held.some((t) => t.balance > 0)
      },
      where
    );
  });

  const c = table(
    consolidatedCsv,
    CONSOLIDATED_REQUIRED,
    'consolidated upload',
    builder
  );
  c.rows.forEach((r, i) => {
    const where = `consolidated upload row ${i + 1}`;
    let wallets: unknown;
    try {
      wallets = JSON.parse(r[c.index('wallets')]);
    } catch {
      throw new SiteDayError(`${where}: wallets is not JSON`);
    }
    if (
      !Array.isArray(wallets) ||
      wallets.length === 0 ||
      !wallets.every((x) => typeof x === 'string' && isAddress(x.toLowerCase()))
    ) {
      throw new SiteDayError(`${where}: wallets is not a list of addresses`);
    }
    const members = Array.from(
      new Set((wallets as string[]).map((x) => x.toLowerCase()))
    ).sort((a, b) => (a < b ? -1 : 1));
    if (members.length !== wallets.length) {
      throw new SiteDayError(`${where}: a wallet listed twice`);
    }
    builder.addIdentity(
      uint(r[c.index('block')], `${where} block`),
      r[c.index('date')],
      {
        key: r[c.index('consolidation_key')].toLowerCase(),
        wallets: members,
        boostedTdh: uint(r[c.index('boosted_tdh')], `${where} boosted_tdh`),
        boost: decimal(r[c.index('boost')], `${where} boost`),
        tokens: rowTokens(c, r, where)
      },
      where
    );
  });

  const day = builder.build();
  if (!/^\d{8}$/.test(day.date)) {
    throw new SiteDayError(`date ${JSON.stringify(day.date)} is not YYYYMMDD`);
  }
  return day;
}
