import {
  flooredWeightedNativeVote,
  NativeVotePoint
} from '@/competitions/native-competition-runtime.helpers';
import { HistoryWrite } from './waves-chain-mirror.history';
import { TargetScorePoint } from './waves-chain-mirror.types';

/**
 * Weighted ratings as the runtime computes them (native-competition-runtime
 * service: the leaderboard's decision rating, a winner's votes), from the
 * score history: 6529.io's own rows and the ones this run writes from the
 * chain's VOTE events. The runtime takes the AGGREGATE series for an
 * entry's rating and each VOTER series for a voter's vote, floored over the
 * time lock before the time asked (the value at that time without a lock).
 */
export class WeightedRatings {
  private readonly aggregate = new Map<string, NativeVotePoint[]>();
  private readonly voters = new Map<string, Map<string, NativeVotePoint[]>>();

  constructor(
    history: readonly TargetScorePoint[],
    planned: readonly HistoryWrite[]
  ) {
    for (const row of history) {
      this.add(row.kind, row.entryId, row.voterProfileId, {
        timestamp: row.occurredAt,
        vote: row.value,
        sequence: row.sequence
      });
    }
    // Written after every stored row: ordered after them at equal times.
    planned.forEach((write, i) => {
      const sequence = Number.MAX_SAFE_INTEGER - planned.length + i;
      this.add('AGGREGATE', write.entryRowId, '', {
        timestamp: write.occurredAt,
        vote: write.aggregate,
        sequence
      });
      if (write.voterProfileId) {
        this.add('VOTER', write.entryRowId, write.voterProfileId, {
          timestamp: write.occurredAt,
          vote: write.value,
          sequence
        });
      }
    });
  }

  private add(
    kind: string,
    entryId: string,
    voter: string,
    point: NativeVotePoint
  ) {
    if (kind === 'VOTER') {
      const byVoter = this.voters.get(entryId) ?? new Map();
      byVoter.set(voter, [...(byVoter.get(voter) ?? []), point]);
      this.voters.set(entryId, byVoter);
    } else {
      this.aggregate.set(entryId, [
        ...(this.aggregate.get(entryId) ?? []),
        point
      ]);
    }
  }

  /** An entry's rating at `time`; null when its history is not here. */
  entryRating(entryRowId: string, time: number, timeLockMs: number) {
    const points = this.aggregate.get(entryRowId);
    return points?.length
      ? flooredWeightedNativeVote(points, time, timeLockMs)
      : null;
  }

  /**
   * Each voter's vote on an entry at `time`, by profile (zeros left out);
   * null when the entry's voter history is not here.
   */
  voterVotes(
    entryRowId: string,
    time: number,
    timeLockMs: number
  ): Map<string, number> | null {
    const byVoter = this.voters.get(entryRowId);
    if (!byVoter?.size) return null;
    const out = new Map<string, number>();
    byVoter.forEach((points, voter) => {
      const vote = flooredWeightedNativeVote(points, time, timeLockMs);
      if (vote !== 0) out.set(voter, vote);
    });
    return out;
  }

  /** Whether a voter has a VOTER series on an entry: a vote while mapped. */
  hasVoterSeries(entryRowId: string, voterProfileId: string): boolean {
    return this.voters.get(entryRowId)?.has(voterProfileId) ?? false;
  }
}
