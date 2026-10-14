import type { BaseTDH } from '@/entities/ITDH';

interface RankIdentity {
  wallet?: string;
  consolidation_key?: string;
  wallets?: string[];
}

type Collection = 'memes' | 'gradients' | 'nextgen';
type ScoreField =
  | 'boosted_tdh'
  | 'tdh'
  | 'balance'
  | `${Collection}_tdh`
  | `boosted_${Collection}_tdh`
  | `${Collection}_balance`;
type RankingRow = Pick<BaseTDH, ScoreField> & RankIdentity;

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function identity(row: RankIdentity): string {
  return (
    row.consolidation_key ??
    row.wallet ??
    row.wallets
      ?.map((wallet) => wallet.toLowerCase())
      .sort(compareKeys)
      .join('-') ??
    ''
  ).toLowerCase();
}

function compareScores(
  a: RankingRow,
  b: RankingRow,
  fields: readonly ScoreField[]
): number {
  for (const field of fields) {
    const difference = b[field] - a[field];
    if (difference !== 0) return difference;
  }
  return compareKeys(identity(a), identity(b));
}

export function compareOverallTdh(a: RankingRow, b: RankingRow): number {
  return compareScores(a, b, [
    'boosted_tdh',
    'tdh',
    'gradients_tdh',
    'nextgen_tdh'
  ]);
}

export function compareCollectionTdh(
  a: RankingRow,
  b: RankingRow,
  collection: Collection
): number {
  return compareScores(a, b, [
    `boosted_${collection}_tdh`,
    `${collection}_tdh`,
    `${collection}_balance`,
    'balance'
  ]);
}

export function compareTokenOwners(
  a: RankingRow,
  b: RankingRow,
  aTokenTdh: number,
  bTokenTdh: number
): number {
  return (
    bTokenTdh - aTokenTdh ||
    b.boosted_tdh - a.boosted_tdh ||
    compareKeys(identity(a), identity(b))
  );
}

export function compareTokenTdh(
  a: { tdh: number; id: string | number },
  b: { tdh: number; id: string | number }
): number {
  return b.tdh - a.tdh || Number(a.id) - Number(b.id);
}

/** Preserve funded and consolidated zero-score wallets, excluding empty singletons. */
export function shouldIncludeWalletTdh(
  tdh: number,
  balance: number,
  consolidationSize: number
): boolean {
  return tdh > 0 || balance > 0 || consolidationSize > 1;
}
