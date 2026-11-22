import { mergeDuplicateWallets } from '@/api/api-wallet-helpers';
import { FinalListRow } from './final-list';

export interface PhasedFinalRow extends FinalListRow {
  readonly phase: string | null;
  readonly phaseSubscriptions: number;
  readonly phasePosition: number;
  readonly redeemedCount: number;
}

export interface WalletAmount {
  readonly wallet: string;
  readonly amount: number;
}

export interface PhaseSplit {
  /** Every row of the card, with this phase's rows updated. */
  readonly rows: PhasedFinalRow[];
  /** One entry per airdrop address, amounts summed. */
  readonly airdrops: WalletAmount[];
  /** One entry per phase row, in phase position order. */
  readonly airdropsUnconsolidated: WalletAmount[];
  readonly allowlists: WalletAmount[];
}

export function toPhasedRow(row: FinalListRow): PhasedFinalRow {
  return {
    ...row,
    phase: null,
    phaseSubscriptions: -1,
    phasePosition: -1,
    redeemedCount: 0
  };
}

/**
 * The legacy read order of a card's final rows: subscribed_at ascending
 * (text comparison of the ISO strings). Rows with equal subscribed_at keep
 * the caller's order, which stands in for the database's row order.
 */
export function orderBySubscribedAt<
  T extends Pick<FinalListRow, 'subscribedAt'>
>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (a.row.subscribedAt === b.row.subscribedAt) {
        return a.index - b.index;
      }
      return a.row.subscribedAt < b.row.subscribedAt ? -1 : 1;
    })
    .map(({ row }) => row);
}

function keyWallets(key: string): string[] {
  return key.split('-');
}

function assignPhase(
  allRows: readonly PhasedFinalRow[],
  phaseRows: readonly PhasedFinalRow[],
  phaseName: string
): { rows: PhasedFinalRow[]; positions: Map<string, number> } {
  const positions = new Map<string, number>();
  phaseRows.forEach((row, index) => positions.set(row.key, index + 1));
  const phaseKeys = new Set(phaseRows.map((row) => row.key));
  const rows = allRows.map((row) =>
    phaseKeys.has(row.key)
      ? {
          ...row,
          phase: phaseName,
          phaseSubscriptions: phaseRows.length,
          phasePosition: positions.get(row.key) ?? -1
        }
      : row
  );
  return { rows, positions };
}

/**
 * One phase of the legacy allowlist split (subscriptions
 * api.subscriptions.allowlist splitAllowlistResults). A row with no phase yet
 * whose key holds a result wallet joins this phase, so the first phase pulled
 * wins. Each joined row is an airdrop of its full count to its airdrop
 * address; the result wallet that matched it gets one fewer allowlist spot.
 *
 * `mintingDelegateOf` maps a wallet to its minting delegate (use case 2) as
 * the legacy split does; without it allowlist wallets stay as they are.
 */
export function splitPhase(params: {
  readonly rows: readonly PhasedFinalRow[];
  readonly phaseName: string;
  readonly results: readonly WalletAmount[];
  readonly mintingDelegateOf?: (wallet: string) => string | undefined;
}): PhaseSplit {
  const wallets = params.results.map((r) => r.wallet.toLowerCase());
  if (new Set(wallets).size !== wallets.length) {
    throw new Error('List has duplicates. Cannot process!');
  }
  const walletSet = new Set(wallets);
  const ordered = orderBySubscribedAt(params.rows);
  const phaseRows = ordered.filter(
    (row) =>
      !row.phase && keyWallets(row.key).some((wallet) => walletSet.has(wallet))
  );

  const subscriptionByWallet = new Map<string, PhasedFinalRow>();
  for (const row of phaseRows) {
    for (const wallet of keyWallets(row.key)) {
      const walletKey = wallet.toLowerCase();
      if (!subscriptionByWallet.has(walletKey)) {
        subscriptionByWallet.set(walletKey, row);
      }
    }
  }

  const airdropsUnconsolidated: WalletAmount[] = phaseRows.map((row) => ({
    wallet: row.airdropAddress ?? '',
    amount: row.subscribedCount
  }));

  const toMintingAddress = (wallet: string) =>
    params.mintingDelegateOf?.(wallet) ?? wallet;
  const usedKeys = new Set<string>();
  const allowlists: WalletAmount[] = [];
  for (const result of params.results) {
    const wallet = result.wallet.toLowerCase();
    const subscription = subscriptionByWallet.get(wallet);
    if (subscription && !usedKeys.has(subscription.key)) {
      usedKeys.add(subscription.key);
      if (result.amount > 1) {
        allowlists.push({
          wallet: toMintingAddress(wallet),
          amount: result.amount - 1
        });
      }
    } else {
      allowlists.push({
        wallet: toMintingAddress(wallet),
        amount: result.amount
      });
    }
  }

  const { rows } = assignPhase(params.rows, phaseRows, params.phaseName);
  return {
    rows,
    airdrops: mergeDuplicateWallets(airdropsUnconsolidated),
    airdropsUnconsolidated,
    allowlists: mergeDuplicateWallets(allowlists)
  };
}

/**
 * The legacy public phase (getPublicSubscriptions): every row still without a
 * phase is airdropped one card, whatever its count, in subscribed_at order.
 */
export function assignPublicPhase(rows: readonly PhasedFinalRow[]): {
  readonly rows: PhasedFinalRow[];
  readonly airdrops: WalletAmount[];
  readonly airdropsUnconsolidated: WalletAmount[];
} {
  const publicRows = orderBySubscribedAt(rows).filter((row) => !row.phase);
  const airdropsUnconsolidated = publicRows.map((row) => ({
    wallet: row.airdropAddress ?? '',
    amount: 1
  }));
  const assigned = assignPhase(rows, publicRows, 'Public');
  return {
    rows: assigned.rows,
    airdrops: mergeDuplicateWallets(airdropsUnconsolidated),
    airdropsUnconsolidated
  };
}

/**
 * Applies phase membership that is already known (from the legacy rows) in
 * legacy order: each named phase takes its keys in subscribed_at order, and
 * positions count from 1 within the phase. Used when the phase inputs (the
 * allowlist service's results) are not available, as in the public-API run.
 */
export function applyKnownPhases(
  rows: readonly PhasedFinalRow[],
  phaseByKey: ReadonlyMap<string, string>
): PhasedFinalRow[] {
  const ordered = orderBySubscribedAt(rows);
  const byPhase = new Map<string, PhasedFinalRow[]>();
  for (const row of ordered) {
    const phase = phaseByKey.get(row.key);
    if (phase) {
      const list = byPhase.get(phase) ?? [];
      list.push(row);
      byPhase.set(phase, list);
    }
  }
  let result: PhasedFinalRow[] = rows.map((row) => ({ ...row }));
  for (const [phase, phaseRows] of Array.from(byPhase.entries())) {
    result = assignPhase(result, phaseRows, phase).rows;
  }
  return result;
}

/** A phase's airdrops as the legacy split sends them. */
export function phaseAirdrops(
  rows: readonly PhasedFinalRow[],
  phaseName: string
): { airdrops: WalletAmount[]; airdropsUnconsolidated: WalletAmount[] } {
  const phaseRows = rows
    .filter((row) => row.phase === phaseName)
    .sort((a, b) => a.phasePosition - b.phasePosition);
  const amountOf = (row: PhasedFinalRow) =>
    phaseName === 'Public' ? 1 : row.subscribedCount;
  const airdropsUnconsolidated = phaseRows.map((row) => ({
    wallet: row.airdropAddress ?? '',
    amount: amountOf(row)
  }));
  return {
    airdrops: mergeDuplicateWallets(airdropsUnconsolidated),
    airdropsUnconsolidated
  };
}
