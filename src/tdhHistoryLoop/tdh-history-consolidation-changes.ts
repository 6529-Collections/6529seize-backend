import { consolidationTools } from '@/consolidation-tools';
import type { ConsolidatedTDH, TokenTDH } from '@/entities/ITDH';
import {
  addTokensToIndex,
  calculateTokenIndexTdhChanges
} from './tdh-history-changes';
import type { TokenIndex, TokenTdhChanges } from './tdh-history-changes';

type TokenField = 'memes' | 'gradients' | 'nextgen';
type ChangeField = keyof TokenTdhChanges;
type AllocationBasis = 'tdh' | 'boosted_tdh' | 'tdh__raw' | 'balance';

const CHANGE_FIELDS: Array<{
  field: ChangeField;
  basis: AllocationBasis;
}> = [
  { field: 'tdhCreated', basis: 'tdh' },
  { field: 'tdhDestroyed', basis: 'tdh' },
  { field: 'boostedTdhCreated', basis: 'boosted_tdh' },
  { field: 'boostedTdhDestroyed', basis: 'boosted_tdh' },
  { field: 'rawTdhCreated', basis: 'tdh__raw' },
  { field: 'rawTdhDestroyed', basis: 'tdh__raw' },
  { field: 'balanceCreated', basis: 'balance' },
  { field: 'balanceDestroyed', basis: 'balance' }
];

export interface ConsolidationChangeAllocation {
  current: ConsolidatedTDH;
  changes: TokenTdhChanges;
}

export interface ConsolidationChangePlan {
  allocations: ConsolidationChangeAllocation[];
  lost: ConsolidatedTDH[];
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

function walletSet(entry: ConsolidatedTDH): Set<string> {
  return new Set(
    entry.consolidation_key.split('-').map((wallet) => wallet.toLowerCase())
  );
}

function entriesMatch(
  current: ConsolidatedTDH,
  previous: ConsolidatedTDH
): boolean {
  const currentKey = current.consolidation_key.toLowerCase();
  const previousKeys = new Set([
    previous.consolidation_key.toLowerCase(),
    consolidationTools.buildConsolidationKey(previous.wallets).toLowerCase()
  ]);
  if (previousKeys.has(currentKey)) {
    return true;
  }

  const currentWallets = walletSet(current);
  for (const previousWallet of Array.from(walletSet(previous))) {
    if (currentWallets.has(previousWallet)) {
      return true;
    }
  }
  return false;
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

function buildTokenIndex(
  entries: ConsolidatedTDH[],
  field: TokenField
): TokenIndex {
  const index: TokenIndex = new Map();
  for (const entry of entries) {
    addTokensToIndex(
      index,
      entry[field] as TokenTDH[] | undefined,
      entry.boost
    );
  }
  return index;
}

function addChanges(target: TokenTdhChanges, source: TokenTdhChanges): void {
  for (const { field } of CHANGE_FIELDS) {
    target[field] += source[field];
  }
}

function calculateGroupChanges(
  current: ConsolidatedTDH[],
  previous: ConsolidatedTDH[]
): TokenTdhChanges {
  const changes = emptyChanges();
  for (const field of ['memes', 'gradients', 'nextgen'] as const) {
    addChanges(
      changes,
      calculateTokenIndexTdhChanges(
        buildTokenIndex(current, field),
        buildTokenIndex(previous, field)
      )
    );
  }
  return changes;
}

function allocateInteger(
  total: number,
  current: ConsolidatedTDH[],
  basis: AllocationBasis
): number[] {
  if (total === 0) {
    return current.map(() => 0);
  }

  const basisValues = current.map((entry) => Math.max(0, entry[basis]));
  const basisTotal = basisValues.reduce((sum, value) => sum + value, 0);
  if (basisTotal === 0) {
    return current.map((_entry, index) => (index === 0 ? total : 0));
  }

  const exact = basisValues.map((value) => (total * value) / basisTotal);
  const allocated = exact.map((value) => Math.floor(value));
  let remainder = total - allocated.reduce((sum, value) => sum + value, 0);
  const remainderOrder = exact
    .map((value, index) => ({
      fraction: value - allocated[index],
      index,
      key: current[index].consolidation_key.toLowerCase()
    }))
    .sort((a, b) => b.fraction - a.fraction || a.key.localeCompare(b.key));

  for (let index = 0; remainder > 0; index++, remainder--) {
    allocated[remainderOrder[index % remainderOrder.length].index]++;
  }
  return allocated;
}

function allocateGroupChanges(
  currentEntries: ConsolidatedTDH[],
  changes: TokenTdhChanges
): ConsolidationChangeAllocation[] {
  // A split has no unique per-child previous snapshot. Allocate the connected
  // group's changes by current holdings while preserving every integer total.
  const current = [...currentEntries].sort((a, b) =>
    a.consolidation_key.localeCompare(b.consolidation_key)
  );
  const allocations = current.map((entry) => ({
    current: entry,
    changes: emptyChanges()
  }));

  for (const { field, basis } of CHANGE_FIELDS) {
    const values = allocateInteger(changes[field], current, basis);
    values.forEach((value, index) => {
      allocations[index].changes[field] = value;
    });
  }
  return allocations;
}

export function calculateConsolidationChangePlan(
  current: ConsolidatedTDH[],
  previous: ConsolidatedTDH[]
): ConsolidationChangePlan {
  const currentToPrevious = current.map(() => [] as number[]);
  const previousToCurrent = previous.map(() => [] as number[]);

  const previousByKey = new Map<string, number[]>();
  const previousByWallet = new Map<string, number[]>();
  previous.forEach((entry, previousIndex) => {
    addIndexEntry(
      previousByKey,
      entry.consolidation_key.toLowerCase(),
      previousIndex
    );
    addIndexEntry(
      previousByKey,
      consolidationTools.buildConsolidationKey(entry.wallets).toLowerCase(),
      previousIndex
    );
    for (const wallet of Array.from(walletSet(entry))) {
      addIndexEntry(previousByWallet, wallet, previousIndex);
    }
  });

  current.forEach((currentEntry, currentIndex) => {
    const candidates = new Set(
      previousByKey.get(currentEntry.consolidation_key.toLowerCase()) ?? []
    );
    for (const wallet of Array.from(walletSet(currentEntry))) {
      for (const previousIndex of previousByWallet.get(wallet) ?? []) {
        candidates.add(previousIndex);
      }
    }

    candidates.forEach((previousIndex) => {
      const previousEntry = previous[previousIndex];
      if (entriesMatch(currentEntry, previousEntry)) {
        currentToPrevious[currentIndex].push(previousIndex);
        previousToCurrent[previousIndex].push(currentIndex);
      }
    });
  });

  const visitedCurrent = new Set<number>();
  const visitedPrevious = new Set<number>();
  const allocations: ConsolidationChangeAllocation[] = [];

  current.forEach((_entry, startingCurrentIndex) => {
    if (visitedCurrent.has(startingCurrentIndex)) {
      return;
    }

    const currentQueue = [startingCurrentIndex];
    const groupCurrent = new Set<number>();
    const groupPrevious = new Set<number>();
    while (currentQueue.length > 0) {
      const currentIndex = currentQueue.pop()!;
      if (groupCurrent.has(currentIndex)) {
        continue;
      }
      groupCurrent.add(currentIndex);
      visitedCurrent.add(currentIndex);

      for (const previousIndex of currentToPrevious[currentIndex]) {
        if (!groupPrevious.has(previousIndex)) {
          groupPrevious.add(previousIndex);
          visitedPrevious.add(previousIndex);
          for (const siblingCurrent of previousToCurrent[previousIndex]) {
            currentQueue.push(siblingCurrent);
          }
        }
      }
    }

    const groupCurrentEntries = Array.from(groupCurrent).map(
      (index) => current[index]
    );
    const groupPreviousEntries = Array.from(groupPrevious).map(
      (index) => previous[index]
    );
    allocations.push(
      ...allocateGroupChanges(
        groupCurrentEntries,
        calculateGroupChanges(groupCurrentEntries, groupPreviousEntries)
      )
    );
  });

  return {
    allocations,
    lost: previous.filter((_entry, index) => !visitedPrevious.has(index))
  };
}
