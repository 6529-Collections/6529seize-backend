import { PlanCounter, safeAmount } from './waves-chain-mirror.plan-support';
import { MirrorLookups, TargetEntry } from './waves-chain-mirror.types';

/**
 * Vote history from the event log's VOTE events (competition_vote_history
 * and competition_score_history): what the runtime's recordVoteChange
 * writes for each vote change, so the activity routes, the vote logs, the
 * "votes over time" views and the weighted ratings read the chain's
 * changes as they read 6529.io's own. History from before the switch stays
 * 6529.io's.
 *
 * Each event is written once (waves_chain_mirror_events keeps the events
 * written), in the order of the log. A RELEASE event is a credit return,
 * not a change of the vote 6529.io shows, and is left out; a scan's cut
 * and an ambiguous change carry their origin as the reason.
 */

/** A VOTE event of the log, as the history needs it. */
export interface VoteEvent {
  readonly height: number;
  readonly seq: number;
  readonly blockTime: number;
  readonly origin: string;
  readonly entryId: string;
  readonly voter: string;
  readonly oldValue: string | null;
  readonly newValue: string;
  readonly entryTotalAfter: string | null;
}

export interface HistoryWrite {
  readonly height: number;
  readonly seq: number;
  readonly entryRowId: string;
  readonly dropId: string;
  readonly submitterId: string;
  /**
   * The voter's profile; null for a voter the identity mirror has not
   * mapped: then only the entry's AGGREGATE point is written (the vote
   * history row and the VOTER point name a profile).
   */
  readonly voterProfileId: string | null;
  readonly value: number;
  readonly previous: number;
  readonly aggregate: number;
  readonly occurredAt: number;
  readonly reason: string | null;
}

export function planHistory(input: {
  readonly lookups: MirrorLookups;
  readonly entries: ReadonlyMap<string, TargetEntry>;
  readonly counter: PlanCounter;
}): HistoryWrite[] {
  const { lookups, entries, counter } = input;
  const out: HistoryWrite[] = [];
  for (const event of lookups.voteEvents()) {
    if (event.origin === 'RELEASE') continue;
    const entry = entries.get(event.entryId);
    if (!entry) {
      counter.wait('history_entry_without_row');
      continue;
    }
    const voterProfileId = lookups.profileOf(event.voter);
    if (!voterProfileId) counter.wait('history_voter_unmapped');
    const value = safeAmount(event.newValue);
    const previous = safeAmount(event.oldValue ?? '0');
    const aggregate = safeAmount(event.entryTotalAfter);
    if (value === null || previous === null || aggregate === null) {
      counter.wait('history_out_of_range');
      continue;
    }
    out.push({
      height: event.height,
      seq: event.seq,
      entryRowId: entry.id,
      dropId: entry.dropId,
      submitterId: entry.submitterId,
      voterProfileId,
      value,
      previous,
      aggregate,
      occurredAt: event.blockTime,
      reason:
        event.origin === 'OPERATION'
          ? null
          : `chain_${event.origin.toLowerCase()}`
    });
    if (voterProfileId) counter.change('competition_vote_history', 'insert');
    counter.change(
      'competition_score_history',
      'insert',
      voterProfileId ? 2 : 1
    );
  }
  return out;
}
