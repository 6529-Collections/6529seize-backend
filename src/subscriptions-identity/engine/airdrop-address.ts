import {
  DELEGATION_ALL_ADDRESS,
  MEMES_CONTRACT,
  USE_CASE_AIRDROPS,
  USE_CASE_ALL
} from '@/constants';
import { AirdropTarget } from './final-list';

/** One delegation as the legacy `delegations` table holds it. */
export interface DelegationRow {
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly collection: string;
  readonly useCase: number;
  readonly block: number;
  /** Unix seconds. */
  readonly expiry: number;
  readonly allTokens: boolean;
}

export interface ResolvedAirdropTarget extends AirdropTarget {
  /** Where the legacy query leaves the choice to the database's row order. */
  readonly ties: ReadonlyArray<'DELEGATION_RANK' | 'DELEGATOR_BLOCK' | 'TDH'>;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function priority(row: DelegationRow): number {
  const memes = lower(row.collection) === lower(MEMES_CONTRACT);
  const airdrops = row.useCase === USE_CASE_AIRDROPS;
  if (memes) {
    return airdrops ? 1 : 2;
  }
  return airdrops ? 3 : 4;
}

function isCandidate(row: DelegationRow): boolean {
  const collection = lower(row.collection);
  return (
    (collection === lower(MEMES_CONTRACT) ||
      collection === lower(DELEGATION_ALL_ADDRESS)) &&
    (row.useCase === USE_CASE_AIRDROPS || row.useCase === USE_CASE_ALL) &&
    row.allTokens
  );
}

function compareRank(a: DelegationRow, b: DelegationRow): number {
  const byPriority = priority(a) - priority(b);
  if (byPriority !== 0) {
    return byPriority;
  }
  return b.block - a.block;
}

function topPerDelegator(
  rows: readonly DelegationRow[],
  ties: Set<ResolvedAirdropTarget['ties'][number]>
): DelegationRow[] {
  const byDelegator = new Map<string, DelegationRow[]>();
  for (const row of rows.filter(isCandidate)) {
    const from = lower(row.fromAddress);
    byDelegator.set(from, [...(byDelegator.get(from) ?? []), row]);
  }
  const top: DelegationRow[] = [];
  for (const list of Array.from(byDelegator.values())) {
    const sorted = list
      .slice()
      .sort(
        (a, b) =>
          compareRank(a, b) ||
          (lower(a.toAddress) < lower(b.toAddress) ? -1 : 1)
      );
    if (
      sorted.length > 1 &&
      compareRank(sorted[0], sorted[1]) === 0 &&
      lower(sorted[0].toAddress) !== lower(sorted[1].toAddress)
    ) {
      ties.add('DELEGATION_RANK');
    }
    top.push(sorted[0]);
  }
  return top;
}

function highestTdhWallet(
  wallets: readonly string[],
  boostedTdhByWallet: ReadonlyMap<string, number>,
  ties: Set<ResolvedAirdropTarget['ties'][number]>
): string | null {
  const ranked = wallets
    .filter((w) => boostedTdhByWallet.has(w))
    .map((w) => ({ wallet: w, tdh: boostedTdhByWallet.get(w) ?? 0 }))
    .sort((a, b) => b.tdh - a.tdh || (a.wallet < b.wallet ? -1 : 1));
  if (ranked.length > 1 && ranked[0].tdh === ranked[1].tdh) {
    ties.add('TDH');
  }
  return ranked[0]?.wallet ?? null;
}

/**
 * The airdrop address of a consolidation key, by the legacy rules
 * (delegationsLoop db.delegations fetchAirdropAddressForConsolidationKey):
 *
 * - candidates: use case 3 (airdrops) or 1 (all), on the Memes contract or
 *   all collections, for all tokens;
 * - per delegator, the most specific (Memes and 3, Memes and 1, all and 3,
 *   all and 1), then the latest block. Expiry is checked only after this, so
 *   an expired specific record hides a live general one;
 * - among the key's wallets' remaining records, the latest block wins;
 * - otherwise the wallet with the highest boosted TDH at the latest TDH block
 *   (a one-wallet key is its own TDH wallet).
 *
 * Where the legacy query leaves a tie to the database, this takes the lowest
 * address and reports the tie.
 */
export function resolveAirdropTarget(params: {
  readonly key: string;
  /**
   * The identity's wallets. Without them the key is read as a legacy
   * consolidation key (wallets joined by "-"); a principal id needs them.
   */
  readonly wallets?: readonly string[];
  readonly delegations: readonly DelegationRow[];
  readonly boostedTdhByWallet: ReadonlyMap<string, number>;
  readonly nowSeconds: number;
}): ResolvedAirdropTarget {
  const wallets = params.wallets
    ? params.wallets.map(lower)
    : lower(params.key).split('-');
  const ties = new Set<ResolvedAirdropTarget['ties'][number]>();
  let tdhWallet: string | null;
  if (wallets.length >= 2) {
    tdhWallet = highestTdhWallet(wallets, params.boostedTdhByWallet, ties);
  } else {
    tdhWallet = params.wallets ? (wallets[0] ?? null) : params.key;
  }

  const walletSet = new Set(wallets);
  const live = topPerDelegator(
    params.delegations.filter((d) => walletSet.has(lower(d.fromAddress))),
    ties
  )
    .filter((d) => d.expiry >= params.nowSeconds)
    .sort(
      (a, b) =>
        b.block - a.block ||
        (lower(a.fromAddress) < lower(b.fromAddress) ? -1 : 1)
    );
  if (
    live.length > 1 &&
    live[0].block === live[1].block &&
    lower(live[0].toAddress) !== lower(live[1].toAddress)
  ) {
    ties.add('DELEGATOR_BLOCK');
  }
  const airdropAddress = live[0] ? lower(live[0].toAddress) : tdhWallet;
  return { airdropAddress, tdhWallet, ties: Array.from(ties) };
}
