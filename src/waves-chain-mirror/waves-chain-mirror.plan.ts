import {
  mapEntries,
  PlanCounter,
  TableChanges
} from './waves-chain-mirror.plan-support';
import {
  ChainDecisionState,
  MirrorLookups,
  TargetCompetitionState
} from './waves-chain-mirror.types';
import { planVoteWrites, VoteWrites } from './waves-chain-mirror.votes';
import {
  EntryRemoval,
  isReleasedEntry,
  planEntryRemovals
} from './waves-chain-mirror.entries';
import { planResults, ResultWrites } from './waves-chain-mirror.results';
import { HistoryWrite, planHistory } from './waves-chain-mirror.history';
import { WeightedRatings } from './waves-chain-mirror.weighted';
import {
  NativeEntryWrite,
  planNativeEntries
} from './waves-chain-mirror.native-entries';

/**
 * What the mirror writes for one decision: the difference between the
 * chain's state (the index's rows) and 6529.io's rows, as writes keyed by
 * derived ids. Pure: the same two sides give the same writes, and once they
 * are applied, the next plan is empty. A report-only run counts them and
 * writes nothing.
 */

/** The writes of one decision, by area. */
export type MirrorWrites = VoteWrites & {
  /** Entries made on the chain: their drops and entries, written first. */
  readonly nativeEntries: NativeEntryWrite[];
  /** Entries the chain withdrew or disqualified: deleted as 6529.io does. */
  readonly entryRemovals: EntryRemoval[];
  /** The chain's results and the decision's lifecycle. */
  readonly results: ResultWrites;
  /** Vote and score history of the VOTE events this run read. */
  readonly history: HistoryWrite[];
};

export interface DecisionPlan {
  readonly competitionId: string;
  readonly waveId: string;
  /** The run's time: the stamp of the outbox events of the writes. */
  readonly at: number;
  /** The chain's network id (its events are marked written under it). */
  readonly network: string | null;
  /** The competition's capabilities (MAIN_STAGE, for its events). */
  readonly capabilities: readonly string[];
  readonly writes: MirrorWrites;
  /** The writes counted by table. */
  readonly changes: Record<string, TableChanges>;
  /**
   * Chain rows the mirror can't write yet, by reason (an unmapped voter, an
   * entry 6529.io has no row of): they wait for a later run.
   */
  readonly waiting: Record<string, number>;
}

/** How many rows a plan writes. */
export function planWrites(plan: Pick<DecisionPlan, 'changes'>): number {
  return Object.values(plan.changes).reduce(
    (sum, c) => sum + c.insert + c.update + c.delete,
    0
  );
}

export interface PlanInput {
  readonly chain: ChainDecisionState;
  readonly target: TargetCompetitionState;
  readonly lookups: MirrorLookups;
}

/**
 * The plan of one decision. The entries 6529.io has no row of are counted
 * as waiting: their votes, board rows and results wait with them.
 */
export function planDecision(input: PlanInput): DecisionPlan {
  const { chain, target } = input;
  const counter = new PlanCounter();
  const entries = mapEntries(chain.entries, target.entries);
  const entryRemovals = planEntryRemovals({ chain, entries, counter });
  const nativeEntries = planNativeEntries({ ...input, entries, counter });
  // An entry the chain released has no row once removed: nothing waits.
  const released = new Set(
    chain.entries.filter(isReleasedEntry).map((e) => e.entryId)
  );
  counter.wait(
    'entry_without_row',
    chain.entries.filter(
      (e) => !entries.has(e.entryId) && !released.has(e.entryId)
    ).length
  );
  // The rest of the plan reads 6529.io as the removals leave it.
  const removed = new Set(entryRemovals.map((r) => r.id));
  const area = {
    ...input,
    target: {
      ...target,
      entries: target.entries.filter((e) => !removed.has(e.id)),
      votes: target.votes.filter((v) => !removed.has(v.entryId)),
      runtime: target.runtime.filter((r) => !removed.has(r.entryId)),
      board: target.board.filter((b) => !removed.has(b.entryId))
    },
    entries,
    released,
    counter
  };
  const history = planHistory(area);
  const weighted = new WeightedRatings(target.scoreHistory, history);
  const votes = planVoteWrites({ ...area, weighted });
  const results = planResults({ ...area, weighted });
  // Winners leave the board once, with the board's own removals.
  const offBoard = new Set(votes.board.remove);
  const winnersOff = results.boardRemove.filter((id) => !offBoard.has(id));
  counter.change(
    'competition_leaderboard_entries',
    'delete',
    winnersOff.length
  );
  const board = {
    upsert: votes.board.upsert,
    remove: [...votes.board.remove, ...winnersOff]
  };
  return {
    competitionId: target.competition.id,
    waveId: target.competition.waveId,
    at: input.lookups.now,
    network: input.lookups.network,
    capabilities: target.competition.capabilities,
    writes: {
      ...votes,
      board,
      nativeEntries,
      entryRemovals,
      history,
      results: { ...results, boardRemove: [] }
    },
    changes: counter.changes,
    waiting: counter.waiting
  };
}
