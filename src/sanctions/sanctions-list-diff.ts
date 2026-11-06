import type {
  SanctionsListV1,
  SanctionsSourceId
} from '@/sanctions/sanctions-list.types';
import { compareCodePoints } from '@/sanctions/sanctions-text';

export interface SanctionsSourceDiff {
  readonly source: SanctionsSourceId;
  readonly added: string[];
  readonly removed: string[];
}

export interface SanctionsListDiff {
  readonly added: string[];
  readonly removed: string[];
  readonly by_source: SanctionsSourceDiff[];
}

function addressesBySource(
  list: SanctionsListV1
): Record<string, Record<string, true>> {
  const result: Record<string, Record<string, true>> = {};
  for (const source of list.sources) {
    result[source.id] = {};
  }
  for (const entry of list.addresses) {
    for (const listing of entry.listings) {
      (result[listing.source] = result[listing.source] ?? {})[entry.address] =
        true;
    }
  }
  return result;
}

function difference(
  left: Record<string, true>,
  right: Record<string, true>
): string[] {
  return Object.keys(left)
    .filter((key) => !right[key])
    .sort(compareCodePoints);
}

function addressSet(list: SanctionsListV1): Record<string, true> {
  const result: Record<string, true> = {};
  for (const entry of list.addresses) {
    result[entry.address] = true;
  }
  return result;
}

/** Addresses added and removed, overall and per source. Public data only. */
export function diffSanctionsLists(
  previous: SanctionsListV1,
  next: SanctionsListV1
): SanctionsListDiff {
  const before = addressesBySource(previous);
  const after = addressesBySource(next);
  const sources = Object.keys(before)
    .concat(Object.keys(after).filter((source) => !before[source]))
    .sort(compareCodePoints);
  return {
    added: difference(addressSet(next), addressSet(previous)),
    removed: difference(addressSet(previous), addressSet(next)),
    by_source: sources
      .map((source) => ({
        source: source as SanctionsSourceId,
        added: difference(after[source] ?? {}, before[source] ?? {}),
        removed: difference(before[source] ?? {}, after[source] ?? {})
      }))
      .filter((diff) => diff.added.length > 0 || diff.removed.length > 0)
  };
}
