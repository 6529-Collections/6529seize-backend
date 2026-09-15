import { consolidationTools } from '@/consolidation-tools';
import type { ConsolidatedTDH, TokenTDH } from '@/entities/ITDH';
import type { TokenTdhChanges } from './tdh-history-changes';

type Metric = 'tdh' | 'boostedTdh' | 'rawTdh' | 'balance';
type TokenSnapshots = Map<string, TokenSnapshot>;

interface TokenSnapshot {
  tdh: number;
  boostedTdh: number;
  rawTdh: number;
  balance: number;
}

export interface ConsolidationChangeAllocation {
  current: ConsolidatedTDH;
  changes: TokenTdhChanges;
}

export interface LostConsolidationChange {
  previous: ConsolidatedTDH;
  changes: TokenTdhChanges;
}

export interface ConsolidationChangePlan {
  allocations: ConsolidationChangeAllocation[];
  lost: LostConsolidationChange[];
}

const METRICS: Metric[] = ['tdh', 'boostedTdh', 'rawTdh', 'balance'];
const CREATED_FIELDS: Record<Metric, keyof TokenTdhChanges> = {
  tdh: 'tdhCreated',
  boostedTdh: 'boostedTdhCreated',
  rawTdh: 'rawTdhCreated',
  balance: 'balanceCreated'
};
const DESTROYED_FIELDS: Record<Metric, keyof TokenTdhChanges> = {
  tdh: 'tdhDestroyed',
  boostedTdh: 'boostedTdhDestroyed',
  rawTdh: 'rawTdhDestroyed',
  balance: 'balanceDestroyed'
};

function emptySnapshot(): TokenSnapshot {
  return { tdh: 0, boostedTdh: 0, rawTdh: 0, balance: 0 };
}

function emptyChanges(): TokenTdhChanges {
  return {
    tdhCreated: 0,
    tdhDestroyed: 0,
    boostedTdhCreated: 0,
    boostedTdhDestroyed: 0,
    rawTdhCreated: 0,
    rawTdhDestroyed: 0,
    balanceCreated: 0,
    balanceDestroyed: 0
  };
}

function addTokens(
  snapshots: TokenSnapshots,
  type: string,
  tokens: TokenTDH[] | undefined,
  boost: number
): void {
  for (const token of tokens ?? []) {
    const key = `${type}:${token.id}`;
    const snapshot = snapshots.get(key) ?? emptySnapshot();
    snapshot.tdh += token.tdh;
    snapshot.boostedTdh += Math.round(token.tdh * boost);
    snapshot.rawTdh += token.tdh__raw;
    snapshot.balance += token.balance;
    snapshots.set(key, snapshot);
  }
}

function buildTokenSnapshots(entry: ConsolidatedTDH): TokenSnapshots {
  const snapshots: TokenSnapshots = new Map();
  addTokens(snapshots, 'memes', entry.memes, entry.boost);
  addTokens(snapshots, 'gradients', entry.gradients, entry.boost);
  addTokens(snapshots, 'nextgen', entry.nextgen, entry.boost);
  return snapshots;
}

function normalizedWallets(entry: ConsolidatedTDH): Set<string> {
  const wallets = new Set(
    entry.consolidation_key
      .split('-')
      .filter(Boolean)
      .map((wallet) => wallet.toLowerCase())
  );
  if (Array.isArray(entry.wallets)) {
    entry.wallets.forEach((wallet) => {
      if (typeof wallet === 'string') {
        wallets.add(wallet.toLowerCase());
      }
    });
  }
  return wallets;
}

function addIndexEntry(
  index: Map<string, number[]>,
  key: string,
  entryIndex: number
): void {
  const entries = index.get(key) ?? [];
  entries.push(entryIndex);
  index.set(key, entries);
}

function findPreviousIndexes(
  current: ConsolidatedTDH,
  previousByKey: Map<string, number[]>,
  previousByWallet: Map<string, number[]>
): number[] {
  const direct = new Set(
    previousByKey.get(current.consolidation_key.toLowerCase()) ?? []
  );
  if (direct.size > 0) {
    return Array.from(direct);
  }

  const matches = new Set<number>();
  normalizedWallets(current).forEach((wallet) => {
    previousByWallet.get(wallet)?.forEach((index) => matches.add(index));
  });
  return Array.from(matches);
}

function compareKeys(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function allocateInteger(
  total: number,
  currentIndexes: number[],
  basis: number[],
  current: ConsolidatedTDH[]
): number[] {
  const basisTotal = basis.reduce((sum, value) => sum + value, 0);
  if (basisTotal <= 0) {
    return basis.map(() => 0);
  }
  const exact = basis.map((value) => (total * value) / basisTotal);
  const allocated = exact.map((value) => Math.floor(value));
  let remainder = total - allocated.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({
      fraction: value - allocated[index],
      index,
      key: current[currentIndexes[index]].consolidation_key.toLowerCase()
    }))
    .sort((a, b) => {
      if (b.fraction !== a.fraction) {
        return b.fraction - a.fraction;
      }
      return compareKeys(a.key, b.key);
    });

  for (let index = 0; remainder > 0; index++, remainder--) {
    allocated[order[index % order.length].index]++;
  }
  return allocated;
}

function addAllocatedMetric(
  snapshots: TokenSnapshots,
  tokenKey: string,
  metric: Metric,
  value: number
): void {
  const snapshot = snapshots.get(tokenKey) ?? emptySnapshot();
  snapshot[metric] += value;
  snapshots.set(tokenKey, snapshot);
}

function addDestroyedMetric(
  changes: TokenTdhChanges,
  metric: Metric,
  value: number
): void {
  changes[DESTROYED_FIELDS[metric]] += value;
}

function exactCurrentIndex(
  previous: ConsolidatedTDH,
  candidates: number[],
  current: ConsolidatedTDH[]
): number | undefined {
  const previousKeys = new Set([
    previous.consolidation_key.toLowerCase(),
    consolidationTools.buildConsolidationKey(previous.wallets).toLowerCase()
  ]);
  return candidates.find((index) =>
    previousKeys.has(current[index].consolidation_key.toLowerCase())
  );
}

function allocatePreviousSnapshot(
  previous: ConsolidatedTDH,
  candidates: number[],
  current: ConsolidatedTDH[],
  currentSnapshots: TokenSnapshots[],
  allocatedPrevious: TokenSnapshots[],
  unallocatedChanges: TokenTdhChanges
): void {
  const previousSnapshots = buildTokenSnapshots(previous);
  const exactIndex = exactCurrentIndex(previous, candidates, current);

  previousSnapshots.forEach((snapshot, tokenKey) => {
    METRICS.forEach((metric) => {
      const total = snapshot[metric];
      if (total === 0) {
        return;
      }
      const basis = candidates.map(
        (index) => currentSnapshots[index].get(tokenKey)?.[metric] ?? 0
      );
      const basisTotal = basis.reduce((sum, value) => sum + value, 0);

      if (basisTotal > 0) {
        allocateInteger(total, candidates, basis, current).forEach(
          (value, candidateIndex) =>
            addAllocatedMetric(
              allocatedPrevious[candidates[candidateIndex]],
              tokenKey,
              metric,
              value
            )
        );
      } else if (candidates.length === 1 || exactIndex !== undefined) {
        addAllocatedMetric(
          allocatedPrevious[exactIndex ?? candidates[0]],
          tokenKey,
          metric,
          total
        );
      } else {
        addDestroyedMetric(unallocatedChanges, metric, total);
      }
    });
  });
}

function applyDelta(
  changes: TokenTdhChanges,
  delta: number,
  metric: Metric
): void {
  if (delta > 0) {
    changes[CREATED_FIELDS[metric]] += delta;
  } else if (delta < 0) {
    addDestroyedMetric(changes, metric, -delta);
  }
}

function calculateChanges(
  current: TokenSnapshots,
  previous: TokenSnapshots
): TokenTdhChanges {
  const changes = emptyChanges();
  const tokenKeys = new Set([
    ...Array.from(current.keys()),
    ...Array.from(previous.keys())
  ]);
  tokenKeys.forEach((tokenKey) => {
    const currentSnapshot = current.get(tokenKey) ?? emptySnapshot();
    const previousSnapshot = previous.get(tokenKey) ?? emptySnapshot();
    METRICS.forEach((metric) =>
      applyDelta(
        changes,
        currentSnapshot[metric] - previousSnapshot[metric],
        metric
      )
    );
  });
  return changes;
}

export function calculateLostConsolidationChanges(
  previous: ConsolidatedTDH
): TokenTdhChanges {
  return {
    tdhCreated: 0,
    tdhDestroyed: previous.tdh,
    boostedTdhCreated: 0,
    boostedTdhDestroyed: previous.boosted_tdh,
    rawTdhCreated: 0,
    rawTdhDestroyed: previous.tdh__raw,
    balanceCreated: 0,
    balanceDestroyed: previous.balance
  };
}

function hasDestroyedChanges(changes: TokenTdhChanges): boolean {
  return (
    changes.tdhDestroyed > 0 ||
    changes.boostedTdhDestroyed > 0 ||
    changes.rawTdhDestroyed > 0 ||
    changes.balanceDestroyed > 0
  );
}

export function calculateConsolidationChangePlan(
  current: ConsolidatedTDH[],
  previous: ConsolidatedTDH[]
): ConsolidationChangePlan {
  const previousByKey = new Map<string, number[]>();
  const previousByWallet = new Map<string, number[]>();
  previous.forEach((entry, index) => {
    addIndexEntry(previousByKey, entry.consolidation_key.toLowerCase(), index);
    addIndexEntry(
      previousByKey,
      consolidationTools.buildConsolidationKey(entry.wallets).toLowerCase(),
      index
    );
    normalizedWallets(entry).forEach((wallet) =>
      addIndexEntry(previousByWallet, wallet, index)
    );
  });

  const previousIndexesByCurrent = current.map((entry) =>
    findPreviousIndexes(entry, previousByKey, previousByWallet)
  );
  const currentIndexesByPrevious = previous.map(() => [] as number[]);
  previousIndexesByCurrent.forEach((indexes, currentIndex) =>
    indexes.forEach((previousIndex) =>
      currentIndexesByPrevious[previousIndex].push(currentIndex)
    )
  );

  const currentSnapshots = current.map(buildTokenSnapshots);
  const allocatedPrevious = current.map(() => new Map() as TokenSnapshots);
  const unallocatedChanges = previous.map(emptyChanges);
  const lost: LostConsolidationChange[] = [];

  previous.forEach((entry, previousIndex) => {
    const candidates = currentIndexesByPrevious[previousIndex];
    if (candidates.length === 0) {
      lost.push({
        previous: entry,
        changes: calculateLostConsolidationChanges(entry)
      });
      return;
    }
    allocatePreviousSnapshot(
      entry,
      candidates,
      current,
      currentSnapshots,
      allocatedPrevious,
      unallocatedChanges[previousIndex]
    );
    if (hasDestroyedChanges(unallocatedChanges[previousIndex])) {
      lost.push({
        previous: entry,
        changes: unallocatedChanges[previousIndex]
      });
    }
  });

  return {
    allocations: current.map((entry, index) => ({
      current: entry,
      changes: calculateChanges(
        currentSnapshots[index],
        allocatedPrevious[index]
      )
    })),
    lost
  };
}
