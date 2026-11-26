import { voteRowId } from './waves-chain-mirror.ids';
import { WeightedRatings } from './waves-chain-mirror.weighted';
import {
  PlanCounter,
  safeAmount,
  timeOf
} from './waves-chain-mirror.plan-support';
import {
  ChainDecisionState,
  MirrorLookups,
  TargetCompetitionState,
  TargetEntry
} from './waves-chain-mirror.types';

/**
 * Votes and leaderboards: the rows every drop object's rating
 * fields and the leaderboard routes read.
 *
 * - competition_votes: the chain's votes on the decision, by (entry row,
 *   voter's profile); `credit_spent` is the vote's size, as the runtime
 *   writes it. Rows the chain doesn't have are deleted, but for a profile
 *   that may be a voter the identity mirror hasn't mapped yet, for an entry
 *   the chain doesn't know, and a vote the chain released: on an entry no
 *   longer ACTIVE, or in a decision no longer published. The chain releases
 *   those to return their credit; 6529.io keeps them as the entry's voters
 *   and its history (credit counts only ACTIVE entries' votes).
 * - competition_entry_runtime: each entry's total and the time of its last
 *   increase (6529.io's own time kept when the chain has none).
 * - competition_leaderboard_entries: the chain's live board while the
 *   decision is published, its score as rating; the decision rating of a
 *   time-locked board is the rating at the next result, projected from the
 *   score history as the runtime projects it (the score where the history
 *   isn't here); rows of
 *   entries no longer on it go. When the decision leaves PUBLISHED, its last
 *   board is kept.
 * Rows are written only when they change, stamped with the run's time.
 */

export interface VoteWrite {
  readonly id: string;
  readonly entryId: string;
  readonly voterProfileId: string;
  readonly value: number;
  readonly creditSpent: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RuntimeWrite {
  readonly entryId: string;
  readonly realTimeRating: number;
  readonly lastIncreasedAt: number | null;
  readonly overThresholdSince: number | null;
  readonly updatedAt: number;
}

export interface BoardWrite {
  readonly entryId: string;
  readonly dropId: string;
  readonly rating: number;
  readonly realTimeRating: number;
  readonly rank: number;
  readonly submittedAt: number;
  readonly orderingTime: number;
  readonly decisionRating: number;
  readonly overThresholdSince: number | null;
  readonly publishedAt: number | null;
  readonly updatedAt: number;
}

export interface VoteWrites {
  readonly votes: { readonly upsert: VoteWrite[]; readonly remove: string[] };
  readonly runtime: { readonly upsert: RuntimeWrite[] };
  readonly board: {
    readonly upsert: BoardWrite[];
    /** Entry row ids. */
    readonly remove: string[];
  };
}

export const NO_VOTE_WRITES: VoteWrites = {
  votes: { upsert: [], remove: [] },
  runtime: { upsert: [] },
  board: { upsert: [], remove: [] }
};

interface Input {
  readonly chain: ChainDecisionState;
  readonly target: TargetCompetitionState;
  readonly lookups: MirrorLookups;
  /** Each chain entry's 6529.io entry row. */
  readonly entries: ReadonlyMap<string, TargetEntry>;
  /** Entries the chain withdrew or disqualified (no row once removed). */
  readonly released: ReadonlySet<string>;
  /** Weighted ratings from the score history. */
  readonly weighted: WeightedRatings;
  readonly counter: PlanCounter;
}

const voteKey = (entryRowId: string, profileId: string) =>
  `${entryRowId}|${profileId}`;

function lastIncreaseOf(data: Record<string, unknown>): number | null {
  const last = data.lastIncrease;
  return last && typeof last === 'object'
    ? timeOf((last as Record<string, unknown>).time)
    : null;
}

export function planVotes(input: Input): VoteWrites['votes'] {
  const { chain, target, lookups, entries, counter } = input;
  const competitionId = target.competition.id;
  const desired = new Map<
    string,
    { entryId: string; profileId: string; value: number; height: number }
  >();
  let unmappedVoters = 0;
  for (const vote of chain.votes) {
    const entry = entries.get(vote.entryId);
    if (!entry) {
      if (!input.released.has(vote.entryId)) {
        counter.wait('vote_entry_without_row');
      }
      continue;
    }
    const profileId = lookups.profileOf(vote.voter);
    if (!profileId) {
      counter.wait('vote_voter_unmapped');
      unmappedVoters++;
      continue;
    }
    const value = safeAmount(vote.value);
    if (value === null) {
      counter.wait('vote_out_of_range');
      continue;
    }
    // The chain stores no zero vote (setting 0 removes it).
    if (value === 0) continue;
    desired.set(voteKey(entry.id, profileId), {
      entryId: entry.id,
      profileId,
      value,
      height: vote.updatedHeight
    });
  }
  const chainEntryRows = new Set(Array.from(entries.values()).map((e) => e.id));
  const published = chain.decision.status === 'published';
  const activeRows = new Set(
    chain.entries
      .filter((e) => e.status === 'active')
      .flatMap((e) => entries.get(e.entryId)?.id ?? [])
  );
  const existing = new Map(
    target.votes.map((v) => [voteKey(v.entryId, v.voterProfileId), v])
  );
  const upsert: VoteWrite[] = [];
  for (const [key, vote] of Array.from(desired.entries())) {
    const stored = existing.get(key);
    const creditSpent = Math.abs(vote.value);
    if (
      stored &&
      stored.value === vote.value &&
      stored.creditSpent === creditSpent
    ) {
      continue;
    }
    // The block's time: a new vote with none known waits; a changed one
    // keeps its row's stamp.
    const at = lookups.blockTime(vote.height) ?? stored?.updatedAt ?? null;
    if (at === null) {
      counter.wait('vote_without_time');
      continue;
    }
    upsert.push({
      id: stored?.id ?? voteRowId(competitionId, vote.entryId, vote.profileId),
      entryId: vote.entryId,
      voterProfileId: vote.profileId,
      value: vote.value,
      creditSpent,
      createdAt: stored?.createdAt ?? at,
      updatedAt: at
    });
    counter.change('competition_votes', stored ? 'update' : 'insert');
  }
  const remove: string[] = [];
  for (const [key, stored] of Array.from(existing.entries())) {
    if (desired.has(key)) continue;
    if (!chainEntryRows.has(stored.entryId)) {
      counter.wait('vote_kept_entry_not_on_chain');
      continue;
    }
    // A vote the chain released stays its voter's: on a winner, and in a
    // decision no longer published (the chain releases all its votes).
    if (!activeRows.has(stored.entryId) || !published) continue;
    if (unmappedVoters > 0 && !lookups.hasPrincipal(stored.voterProfileId)) {
      counter.wait('vote_kept_profile_unmapped');
      continue;
    }
    remove.push(stored.id);
    counter.change('competition_votes', 'delete');
  }
  return { upsert, remove };
}

export function planRuntime(input: Input): VoteWrites['runtime'] {
  const { chain, target, lookups, entries, counter } = input;
  const existing = new Map(target.runtime.map((r) => [r.entryId, r]));
  const upsert: RuntimeWrite[] = [];
  for (const entry of chain.entries) {
    const row = entries.get(entry.entryId);
    if (!row) continue;
    const total = safeAmount(entry.total);
    if (total === null) {
      counter.wait('total_out_of_range');
      continue;
    }
    const stored = existing.get(row.id);
    const lastIncreasedAt =
      lastIncreaseOf(entry.data) ?? stored?.lastIncreasedAt ?? null;
    if (
      stored &&
      stored.realTimeRating === total &&
      stored.lastIncreasedAt === lastIncreasedAt
    ) {
      continue;
    }
    upsert.push({
      entryId: row.id,
      realTimeRating: total,
      lastIncreasedAt,
      overThresholdSince: stored?.overThresholdSince ?? null,
      updatedAt: lookups.now
    });
    counter.change('competition_entry_runtime', stored ? 'update' : 'insert');
  }
  return { upsert };
}

export function planBoard(input: Input): VoteWrites['board'] {
  const { chain, target, lookups, entries, counter } = input;
  if (chain.board === null) return { upsert: [], remove: [] };
  const timeLockMs = Math.max(
    0,
    Number(target.competition.decisionConfig.time_lock_ms ?? 0) || 0
  );
  const timeLocked = timeLockMs > 0;
  // A time-locked board's decision rating is the rating at the next
  // result, as the runtime projects it from the history; the chain's score
  // is the rating now.
  const nextResult =
    chain.decision.data.counted === true && chain.decision.nextResultTime > 0
      ? chain.decision.nextResultTime
      : null;
  const existing = new Map(target.board.map((b) => [b.entryId, b]));
  const kept = new Set<string>();
  const upsert: BoardWrite[] = [];
  for (const row of chain.board) {
    const entry = entries.get(row.entryId);
    if (!entry) {
      counter.wait('board_entry_without_row');
      continue;
    }
    const score = safeAmount(row.score);
    const total = safeAmount(row.total);
    if (score === null || total === null) {
      counter.wait('board_out_of_range');
      continue;
    }
    kept.add(entry.id);
    const next = {
      entryId: entry.id,
      dropId: entry.dropId,
      rating: score,
      realTimeRating: total,
      rank: row.rank,
      submittedAt: entry.submittedAt,
      orderingTime: lastIncreaseOf(row.data) ?? entry.submittedAt,
      decisionRating:
        timeLocked && nextResult !== null
          ? (input.weighted.entryRating(entry.id, nextResult, timeLockMs) ??
            score)
          : score
    };
    const stored = existing.get(entry.id);
    if (
      stored &&
      stored.dropId === next.dropId &&
      stored.rating === next.rating &&
      stored.realTimeRating === next.realTimeRating &&
      stored.rank === next.rank &&
      stored.submittedAt === next.submittedAt &&
      stored.orderingTime === next.orderingTime &&
      stored.decisionRating === next.decisionRating &&
      // A time-locked board's rows are published (the legacy view reads
      // only those), as the runtime does.
      (!timeLocked || stored.publishedAt !== null)
    ) {
      continue;
    }
    upsert.push({
      ...next,
      overThresholdSince: stored?.overThresholdSince ?? null,
      publishedAt: timeLocked ? lookups.now : (stored?.publishedAt ?? null),
      updatedAt: lookups.now
    });
    counter.change(
      'competition_leaderboard_entries',
      stored ? 'update' : 'insert'
    );
  }
  const entryRows = new Set(target.entries.map((e) => e.id));
  const remove: string[] = [];
  for (const stored of target.board) {
    if (kept.has(stored.entryId)) continue;
    // A row with no entry was published before its entry went (imported
    // history): kept, as the runtime keeps it.
    if (!entryRows.has(stored.entryId) && stored.publishedAt !== null) continue;
    remove.push(stored.entryId);
    counter.change('competition_leaderboard_entries', 'delete');
  }
  return { upsert, remove };
}

export function planVoteWrites(input: Input): VoteWrites {
  return {
    votes: planVotes(input),
    runtime: planRuntime(input),
    board: planBoard(input)
  };
}
