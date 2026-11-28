import fetch from 'node-fetch';
import { Readable } from 'node:stream';
import csvParser from 'csv-parser';
import { withArweaveFallback } from '@/arweave-gateway-fallback';
import type { ConsolidatedTDH } from '@/entities/ITDH';
import { parseTdhDataFromDB } from '@/sql_helpers';

type TdhCsvRow = Record<string, string>;
const REQUIRED_COLUMNS = [
  'block',
  'date',
  'consolidation_key',
  'wallets',
  'total_balance',
  'tdh'
] as const;

/** Accept a gateway only after the complete historical snapshot is usable. */
export async function fetchConsolidatedTdhCsv(
  url: string,
  block: number
): Promise<ConsolidatedTDH[]> {
  return withArweaveFallback(url, async (candidate, signal) => {
    const response = await fetch(candidate, { signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch CSV from arweave: ${response.status}`);
    }
    const rows = await parseCsv(await response.text());
    // An empty/error document cannot establish a historical TDH snapshot.
    if (!rows.length) throw new Error('TDH CSV contains no snapshot rows');
    return rows.map((row) => parseSnapshotRow(row, block));
  });
}

async function parseCsv(text: string): Promise<TdhCsvRow[]> {
  return new Promise((resolve, reject) => {
    const rows: TdhCsvRow[] = [];
    Readable.from([text])
      .pipe(csvParser({ strict: true }))
      .on('data', (row: TdhCsvRow) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

function validateSnapshotRow(row: TdhCsvRow, block: number): Date {
  if (REQUIRED_COLUMNS.some((column) => !row[column]?.trim())) {
    throw new Error('TDH CSV is missing required snapshot fields');
  }
  if (!/^\d+$/.test(row.block) || Number(row.block) !== block) {
    throw new Error('TDH CSV block does not match the requested snapshot');
  }
  const isoDate = `${row.date.slice(0, 4)}-${row.date.slice(4, 6)}-${row.date.slice(6, 8)}`;
  const date = new Date(isoDate);
  if (
    !/^\d{8}$/.test(row.date) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== isoDate
  ) {
    throw new Error('TDH CSV has an invalid snapshot date');
  }
  if (
    ![row.tdh, row.total_balance].every((value) =>
      Number.isFinite(Number(value))
    )
  ) {
    throw new Error('TDH CSV has invalid snapshot totals');
  }
  return date;
}

function parseSnapshotRow(row: TdhCsvRow, block: number): ConsolidatedTDH {
  const date = validateSnapshotRow(row, block);
  const tdh = {
    block,
    date,
    consolidation_key: row.consolidation_key,
    consolidation_display: row.consolidation_display || '',
    wallets: row.wallets || '[]',
    balance: integer(row, 'total_balance'),
    unique_memes: integer(row, 'unique_memes'),
    memes_cards_sets: integer(row, 'memes_cards_sets'),
    tdh: integer(row, 'tdh'),
    boost: Number.parseFloat(row.boost) || 0,
    boosted_tdh: integer(row, 'boosted_tdh'),
    tdh__raw: integer(row, 'tdh__raw'),
    tdh_rank: integer(row, 'tdh_rank'),
    tdh_rank_memes: integer(row, 'tdh_rank_memes'),
    tdh_rank_gradients: integer(row, 'tdh_rank_gradients'),
    tdh_rank_nextgen: 0, // Not in CSV, default to 0
    genesis: integer(row, 'genesis'),
    nakamoto: integer(row, 'nakamoto'),
    boosted_memes_tdh: integer(row, 'boosted_memes_tdh'),
    memes_tdh: integer(row, 'memes_tdh'),
    memes_tdh__raw: integer(row, 'memes_tdh__raw'),
    memes_balance: integer(row, 'memes_balance'),
    memes: row.memes || '[]',
    memes_ranks: '[]', // Not in CSV, default to empty array
    gradients_balance: integer(row, 'gradients_balance'),
    boosted_gradients_tdh: integer(row, 'boosted_gradients_tdh'),
    gradients_tdh: integer(row, 'gradients_tdh'),
    gradients_tdh__raw: integer(row, 'gradients_tdh__raw'),
    gradients: row.gradients || '[]',
    gradients_ranks: '[]', // Not in CSV, default to empty array
    nextgen_balance: integer(row, 'nextgen_balance'),
    boosted_nextgen_tdh: integer(row, 'boosted_nextgen_tdh'),
    nextgen_tdh: integer(row, 'nextgen_tdh'),
    nextgen_tdh__raw: integer(row, 'nextgen_tdh__raw'),
    nextgen: row.nextgen || '[]',
    nextgen_ranks: '[]', // Not in CSV, default to empty array
    boost_breakdown: row.boost_breakdown || '{}'
  };
  const parsed = parseTdhDataFromDB(tdh) as ConsolidatedTDH;
  for (const column of ['wallets', 'memes', 'gradients', 'nextgen'] as const) {
    if (!Array.isArray(parsed[column])) {
      throw new TypeError(`TDH CSV ${column} must be a JSON array`);
    }
  }
  if (!parsed.wallets.every((wallet: unknown) => typeof wallet === 'string')) {
    throw new TypeError('TDH CSV wallets must contain strings');
  }
  return parsed;
}

function integer(row: TdhCsvRow, column: string): number {
  return Number.parseInt(row[column]) || 0;
}
