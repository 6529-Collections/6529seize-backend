import { PlanCounter } from './waves-chain-mirror.plan-support';
import {
  ChainDecisionState,
  ChainEntryRow,
  TargetEntry
} from './waves-chain-mirror.types';

/**
 * Entries the chain released by withdrawal or disqualification: removed as
 * 6529.io removes them itself. An author's withdrawal and
 * an admin's disqualification on 6529.io both delete the entry's drop
 * (delete-drop.use-case.ts), and the drop's deletion deletes its entry
 * with its votes, board and runtime rows (competition-entry.repository.ts
 * deleteEntry; an anonymous decision keeps the entry as WITHDRAWN). The
 * mirror runs that same delete, as a backend delete.
 *
 * A win is a result's (waves-chain-mirror.results.ts). An entry the two
 * sides disagree on otherwise (a winner here, released on the chain;
 * released here, active on the chain) is left as it is and counted.
 */

export interface EntryRemoval {
  /** The entry's competition_entries row. */
  readonly id: string;
  readonly dropId: string;
  readonly status: 'WITHDRAWN' | 'DISQUALIFIED';
}

const RELEASED: Record<string, EntryRemoval['status']> = {
  withdrawn: 'WITHDRAWN',
  disqualified: 'DISQUALIFIED'
};

/** Whether the chain released an entry by withdrawal or disqualification. */
export function isReleasedEntry(entry: Pick<ChainEntryRow, 'status'>): boolean {
  return entry.status in RELEASED;
}

/**
 * The entries to remove; each leaves `entries`, so the plan's votes, board
 * and results leave them alone.
 */
export function planEntryRemovals(input: {
  readonly chain: ChainDecisionState;
  readonly entries: Map<string, TargetEntry>;
  readonly counter: PlanCounter;
}): EntryRemoval[] {
  const { chain, entries, counter } = input;
  const out: EntryRemoval[] = [];
  for (const entry of chain.entries) {
    const row = entries.get(entry.entryId);
    if (!row) continue;
    const released = RELEASED[entry.status];
    if (!released) {
      if (entry.status === 'active' && row.status !== 'ACTIVE') {
        counter.wait('entry_status_conflict');
      }
      continue;
    }
    entries.delete(entry.entryId);
    // Removed already (an anonymous decision keeps a WITHDRAWN row).
    if (row.status === 'WITHDRAWN' || row.status === 'DISQUALIFIED') continue;
    if (row.status !== 'ACTIVE') {
      counter.wait('entry_status_conflict');
      continue;
    }
    out.push({ id: row.id, dropId: row.dropId, status: released });
    counter.change('competition_entries', 'delete');
    counter.change('drops', 'delete');
  }
  return out;
}
