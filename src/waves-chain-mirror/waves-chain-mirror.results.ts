import {
  NativeAward,
  nativeAwardsForRank,
  NativeOutcome
} from '@/competitions/native-competition-runtime.helpers';
import { ClaimBuildMessage } from '@/waves-chain-index/waves-chain-index.claims';
import { WeightedRatings } from './waves-chain-mirror.weighted';
import {
  awardRowId,
  chainExecutionKey,
  isChainExecutionKey,
  lifecycleEventId,
  resultDecisionId
} from './waves-chain-mirror.ids';
import {
  chainFinalResults,
  PlanCounter,
  safeAmount,
  historyCoversResult,
  timeOf
} from './waves-chain-mirror.plan-support';
import {
  ChainDecisionState,
  ChainResultRow,
  MirrorLookups,
  TargetCompetitionState,
  TargetEntry
} from './waves-chain-mirror.types';

/**
 * The chain's results and a decision's lifecycle, written as
 * the runtime's saveDecision and saveWinner write them:
 *
 * - competition_decisions: one row a result the chain counted (stage final,
 *   origin native), id as the runtime derives it from the result time;
 *   decided COMPLETED, skipped or cancelled CANCELLED; `decided_at` the
 *   block time it went final (its RESULT_FINAL event); `execution_key`
 *   `chain:<network>:<decisionId>:<resultTime>`. A row 6529.io made for the
 *   same time (its own runtime's) is left alone and counted. Imported
 *   results (origin legacy) are 6529.io's rows already.
 * - competition_decision_winners: rank and final rating (the chain's score).
 * - competition_entries: a winner's status WINNER, won_at = the result time,
 *   rank, decision; its leaderboard row goes.
 * - competition_winner_votes: written once, with the decision row, as the
 *   runtime writes them: each voter's vote weighted over the time lock
 *   before the result time, from the score history (so they add up to the
 *   final rating); without that history, the vote the winner had when it
 *   won (the chain's, or what a RELEASE event took off it since).
 * - competition_outcome_awards: the competition's outcomes for the rank
 *   (nativeAwardsForRank), for a decided result.
 * - competitions: lifecycle forward only (DRAFT, PUBLISHED, ENDED,
 *   ARCHIVED) with its time and a lifecycle event, and a counted decision's
 *   next result time.
 *
 * The rank-1 Main Stage winner is named for the collaboration freeze the
 * runtime makes when it writes a winner
 * (freezeMemeCollaborationForNativeDecision), whenever the mirror writes it.
 * The outbox events of these writes are waves-chain-mirror.apply.ts's.
 */

export interface DecisionRowWrite {
  readonly id: string;
  readonly scheduledAt: number;
  readonly decidedAt: number;
  readonly status: 'COMPLETED' | 'CANCELLED';
  readonly executionKey: string;
  readonly createdAt: number;
}

export interface WinnerWrite {
  readonly decisionId: string;
  readonly entryId: string;
  readonly rank: number;
  readonly finalRating: number;
  readonly createdAt: number;
}

export interface WinnerEntryWrite {
  readonly id: string;
  readonly rank: number;
  readonly wonAt: number;
  readonly decisionId: string;
}

export interface WinnerVoteWrite {
  readonly decisionId: string;
  readonly entryId: string;
  readonly voterProfileId: string;
  readonly value: number;
}

export interface AwardWrite {
  readonly id: string;
  readonly decisionId: string;
  readonly entryId: string;
  readonly outcomePosition: number;
  readonly award: NativeAward;
  readonly createdAt: number;
}

export interface CompetitionWrite {
  /** The lifecycle to move to from `lifecycleFrom`; null: unchanged. */
  readonly lifecycle: string | null;
  readonly lifecycleFrom: string;
  /** undefined: unchanged. */
  readonly nextDecisionTime?: number | null;
  readonly at: number;
}

export interface LifecycleEventWrite {
  readonly id: string;
  readonly previous: string;
  readonly lifecycle: string;
  readonly at: number;
}

export interface ResultWrites {
  readonly decisions: DecisionRowWrite[];
  readonly winners: WinnerWrite[];
  readonly winnerEntries: WinnerEntryWrite[];
  readonly winnerVotes: WinnerVoteWrite[];
  readonly awards: AwardWrite[];
  /**
   * Leaderboard rows of winners (entry row ids), not counted here: the
   * plan removes them with the board's own (waves-chain-mirror.plan.ts).
   */
  readonly boardRemove: string[];
  readonly competition: CompetitionWrite | null;
  readonly lifecycleEvents: LifecycleEventWrite[];
  /** Drop ids of rank-1 Main Stage winners this plan writes. */
  readonly mainStageMints: string[];
  /** Skipped claim builds whose winner has a 6529.io drop now. */
  readonly claimBuilds: ClaimBuildWrite[];
}

/**
 * A claim build the index skipped (the Main Stage winner was made on the
 * chain, with no 6529.io drop yet), made pending with its drop and the
 * claims-builder message (waves-chain-index.claims.ts ClaimBuildMessage),
 * once the mirror has written the drop. The index's next run sends it.
 */
export interface ClaimBuildWrite {
  readonly network: string;
  readonly decisionId: string;
  readonly occurrence: number;
  readonly dropId: string;
  readonly message: ClaimBuildMessage;
}

export const NO_RESULT_WRITES: ResultWrites = {
  decisions: [],
  winners: [],
  winnerEntries: [],
  winnerVotes: [],
  awards: [],
  boardRemove: [],
  competition: null,
  lifecycleEvents: [],
  mainStageMints: [],
  claimBuilds: []
};

const LIFECYCLE: Record<string, string> = {
  draft: 'DRAFT',
  published: 'PUBLISHED',
  ended: 'ENDED',
  archived: 'ARCHIVED'
};
const LIFECYCLE_ORDER = ['DRAFT', 'PUBLISHED', 'ENDED', 'ARCHIVED'];

const DECISION_STATUS: Record<string, DecisionRowWrite['status']> = {
  decided: 'COMPLETED',
  skipped: 'CANCELLED',
  cancelled: 'CANCELLED'
};

interface ChainWinner {
  readonly entryId: string;
  readonly rank: number;
  readonly score: string;
}

function winnersOf(result: ChainResultRow): ChainWinner[] {
  const winners = Array.isArray(result.data.winners) ? result.data.winners : [];
  return winners.flatMap((w) => {
    const winner = (w ?? {}) as Record<string, unknown>;
    const entryId =
      typeof winner.entryId === 'string' ? winner.entryId.toLowerCase() : null;
    const rank = Number(winner.rank);
    if (!entryId || !Number.isSafeInteger(rank) || rank < 1) return [];
    return [{ entryId, rank, score: String(winner.score ?? '0') }];
  });
}

interface Input {
  readonly chain: ChainDecisionState;
  readonly target: TargetCompetitionState;
  readonly lookups: MirrorLookups;
  readonly entries: ReadonlyMap<string, TargetEntry>;
  /** Weighted ratings from the score history. */
  readonly weighted: WeightedRatings;
  readonly counter: PlanCounter;
}

export function planResults(input: Input): ResultWrites {
  const { chain, target, lookups, entries, counter } = input;
  const competitionId = target.competition.id;
  const out = {
    decisions: [] as DecisionRowWrite[],
    winners: [] as WinnerWrite[],
    winnerEntries: [] as WinnerEntryWrite[],
    winnerVotes: [] as WinnerVoteWrite[],
    awards: [] as AwardWrite[],
    boardRemove: [] as string[],
    mainStageMints: [] as string[]
  };
  const byTime = new Map(target.decisions.map((d) => [d.scheduledAt, d]));
  const winnerRows = new Map(
    target.winners.map((w) => [`${w.decisionId}|${w.entryId}`, w])
  );
  const winnerVoteRows = new Map(
    target.winnerVotes.map((v) => [
      `${v.decisionId}|${v.entryId}|${v.voterProfileId}`,
      v
    ])
  );
  const awardRows = new Set(target.awards.map((a) => a.id));
  const boardRows = new Set(target.board.map((b) => b.entryId));
  const chainVotes = new Map<string, Map<string, string>>();
  for (const vote of chain.votes) {
    const votes = chainVotes.get(vote.entryId) ?? new Map<string, string>();
    votes.set(vote.voter, vote.value);
    chainVotes.set(vote.entryId, votes);
  }
  const outcomes = target.competition.outcomeConfig as NativeOutcome[];
  const timeLockMs = Math.max(
    0,
    Number(target.competition.decisionConfig.time_lock_ms ?? 0) || 0
  );
  const mainStage = target.competition.capabilities.includes('MAIN_STAGE');

  for (const result of chainFinalResults(chain)) {
    const status = DECISION_STATUS[result.status];
    if (!status) continue;
    const id = resultDecisionId(competitionId, result.resultTime);
    const stored = byTime.get(result.resultTime);
    if (stored && !isChainExecutionKey(stored.executionKey)) {
      // 6529.io's own runtime decided this time: its row stays.
      counter.wait('result_held_by_6529io');
      continue;
    }
    const decidedAt =
      lookups.resultFinalTime(result.resultTime) ??
      stored?.decidedAt ??
      lookups.blockTime(Number(result.data.settledHeight));
    if (decidedAt === null) {
      // The block it went final in has no known time yet.
      counter.wait('result_without_time');
      continue;
    }
    const executionKey = chainExecutionKey(
      lookups.network,
      chain.decision.decisionId,
      result.resultTime
    );
    const row: DecisionRowWrite = {
      id,
      scheduledAt: result.resultTime,
      decidedAt,
      status,
      executionKey,
      createdAt: stored?.createdAt ?? decidedAt
    };
    if (
      !stored ||
      stored.id !== id ||
      stored.status !== status ||
      stored.executionKey !== executionKey ||
      stored.decidedAt !== decidedAt
    ) {
      out.decisions.push(row);
      counter.change('competition_decisions', stored ? 'update' : 'insert');
    }
    if (status !== 'COMPLETED') continue;
    for (const winner of winnersOf(result)) {
      const entry = entries.get(winner.entryId);
      if (!entry) {
        counter.wait('winner_entry_without_row');
        continue;
      }
      const finalRating = safeAmount(winner.score);
      if (finalRating === null) {
        counter.wait('winner_out_of_range');
        continue;
      }
      const storedWinner = winnerRows.get(`${id}|${entry.id}`);
      if (
        !storedWinner ||
        storedWinner.rank !== winner.rank ||
        storedWinner.finalRating !== finalRating
      ) {
        out.winners.push({
          decisionId: id,
          entryId: entry.id,
          rank: winner.rank,
          finalRating,
          createdAt: decidedAt
        });
        counter.change(
          'competition_decision_winners',
          storedWinner ? 'update' : 'insert'
        );
      }
      if (
        entry.status === 'ACTIVE' ||
        (entry.status === 'WINNER' &&
          (entry.decisionId === null || entry.decisionId === id) &&
          (entry.decisionId !== id ||
            entry.rank !== winner.rank ||
            entry.wonAt !== result.resultTime))
      ) {
        out.winnerEntries.push({
          id: entry.id,
          rank: winner.rank,
          wonAt: result.resultTime,
          decisionId: id
        });
        counter.change('competition_entries', 'update');
        // The runtime freezes the Main Stage winner's collaborations when it
        // writes the winner: here too, whenever the rank-1 winner is
        // written (with its result, or later, once its entry has a row).
        if (mainStage && winner.rank === 1) {
          out.mainStageMints.push(entry.dropId);
        }
      } else if (entry.status !== 'WINNER' || entry.decisionId !== id) {
        counter.wait('winner_status_conflict');
      }
      if (boardRows.has(entry.id)) out.boardRemove.push(entry.id);
      // Its voters' votes, as the runtime writes them: each voter's vote
      // weighted over the time lock before the result time, from the score
      // history, so they add up to the final rating. Without that history
      // here, and for a voter with no series in it (unmapped when voting):
      // the votes it had when it won (the chain's, or what a RELEASE event
      // took off it since). Each is written once, in the first run that has
      // its entry row and its voter's profile, and never changed.
      const weightedVotes = historyCoversResult(chain, result.resultTime)
        ? input.weighted.voterVotes(entry.id, result.resultTime, timeLockMs)
        : null;
      weightedVotes?.forEach((value, profileId) => {
        if (winnerVoteRows.has(`${id}|${entry.id}|${profileId}`)) return;
        out.winnerVotes.push({
          decisionId: id,
          entryId: entry.id,
          voterProfileId: profileId,
          value
        });
        counter.change('competition_winner_votes', 'insert');
      });
      const votes = new Map(lookups.releasedVotes(winner.entryId));
      chainVotes
        .get(winner.entryId)
        ?.forEach((value, voter) => votes.set(voter, value));
      votes.forEach((text, voter) => {
        const profileId = lookups.profileOf(voter);
        if (!profileId) {
          counter.wait('winner_vote_voter_unmapped');
          return;
        }
        if (
          weightedVotes &&
          input.weighted.hasVoterSeries(entry.id, profileId)
        ) {
          return;
        }
        const value = safeAmount(text);
        if (value === null) {
          counter.wait('winner_vote_out_of_range');
          return;
        }
        if (value === 0) return;
        if (winnerVoteRows.has(`${id}|${entry.id}|${profileId}`)) return;
        out.winnerVotes.push({
          decisionId: id,
          entryId: entry.id,
          voterProfileId: profileId,
          value
        });
        counter.change('competition_winner_votes', 'insert');
      });
      for (const award of nativeAwardsForRank(outcomes, winner.rank)) {
        const awardId = awardRowId(id, entry.id, award.outcome_position);
        if (awardRows.has(awardId)) continue;
        out.awards.push({
          id: awardId,
          decisionId: id,
          entryId: entry.id,
          outcomePosition: award.outcome_position,
          award,
          createdAt: decidedAt
        });
        counter.change('competition_outcome_awards', 'insert');
      }
    }
  }
  const { competition, lifecycleEvents } = planCompetition(input);
  return {
    ...out,
    competition,
    lifecycleEvents,
    claimBuilds: planClaimBuilds(input)
  };
}

function planClaimBuilds(input: Input): ClaimBuildWrite[] {
  const { chain, lookups, entries, counter } = input;
  const chainEntries = new Map(chain.entries.map((e) => [e.entryId, e]));
  const out: ClaimBuildWrite[] = [];
  for (const build of lookups.skippedClaimBuilds()) {
    const entry = entries.get(build.entryId);
    const manifestHash = chainEntries.get(build.entryId)?.data.manifestHash;
    if (!entry || typeof manifestHash !== 'string' || !manifestHash) {
      counter.wait('claim_build_without_drop');
      continue;
    }
    out.push({
      network: build.network,
      decisionId: chain.decision.decisionId,
      occurrence: build.occurrence,
      dropId: entry.dropId,
      message: {
        drop_id: entry.dropId,
        chain: {
          decision_id: chain.decision.decisionId,
          occurrence: build.occurrence,
          entry_id: build.entryId,
          height: build.height,
          manifest_hash: manifestHash.toLowerCase()
        }
      }
    });
    counter.change('chain_claim_builds', 'update');
  }
  return out;
}

function planCompetition(input: Input): {
  competition: CompetitionWrite | null;
  lifecycleEvents: LifecycleEventWrite[];
} {
  const { chain, target, lookups, counter } = input;
  const current = target.competition.lifecycle;
  const wanted = LIFECYCLE[chain.decision.status] ?? null;
  const from = LIFECYCLE_ORDER.indexOf(current);
  const to = wanted ? LIFECYCLE_ORDER.indexOf(wanted) : -1;
  let lifecycle: string | null = null;
  if (from >= 0 && to > from) {
    lifecycle = wanted;
  } else if (wanted && wanted !== current) {
    // 6529.io is ahead (or CANCELLED, which the chain has not).
    counter.wait('lifecycle_conflict');
  }
  let nextDecisionTime: number | null | undefined = undefined;
  if (chain.decision.data.counted === true) {
    const next =
      chain.decision.status === 'published'
        ? timeOf(chain.decision.nextResultTime)
        : null;
    const stored = target.competition.decisionConfig.next_decision_time;
    const storedTime =
      stored === null || stored === undefined ? null : Number(stored);
    if (storedTime !== next) nextDecisionTime = next;
  }
  if (lifecycle === null && nextDecisionTime === undefined) {
    return { competition: null, lifecycleEvents: [] };
  }
  counter.change('competitions', 'update');
  const lifecycleEvents: LifecycleEventWrite[] = [];
  if (lifecycle) {
    lifecycleEvents.push({
      id: lifecycleEventId(target.competition.id, lifecycle),
      previous: current,
      lifecycle,
      at: lookups.now
    });
    counter.change('competition_lifecycle_events', 'insert');
  }
  return {
    competition: {
      lifecycle,
      lifecycleFrom: current,
      ...(nextDecisionTime === undefined ? {} : { nextDecisionTime }),
      at: lookups.now
    },
    lifecycleEvents
  };
}
