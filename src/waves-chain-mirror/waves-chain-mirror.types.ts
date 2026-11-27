import type { VoteEvent } from './waves-chain-mirror.history';
import type { NativeEntryLookup } from './waves-chain-mirror.native-entries';

/**
 * The rows the waves chain mirror reads: the chain index's (chain_*), and
 * 6529.io's competition rows they become. Amounts the chain gives as
 * decimal text stay text here; the planner checks they fit before it
 * writes a number.
 */

// ------------------------------------------------------------ the chain

export interface ChainDecisionRow {
  readonly decisionId: string;
  /** 6529.io's competition id, for an imported decision. */
  readonly legacyId: string | null;
  readonly waveId: string;
  /** draft, published, ended or archived. */
  readonly status: string;
  readonly kind: string;
  readonly nextResultTime: number;
  readonly origin: string;
  /** The index's height for the row. */
  readonly height: number;
  /** The API's whole decision object. */
  readonly data: Record<string, unknown>;
}

export interface ChainEntryRow {
  readonly entryId: string;
  /** 6529.io's drop id, for an imported entry. */
  readonly legacyId: string | null;
  readonly decisionId: string;
  readonly author: string;
  /** active, winner, withdrawn or disqualified. */
  readonly status: string;
  readonly total: string;
  readonly origin: string;
  readonly height: number;
  readonly data: Record<string, unknown>;
}

export interface ChainVoteRow {
  readonly entryId: string;
  readonly voter: string;
  readonly value: string;
  readonly updatedHeight: number;
}

export interface ChainBoardRow {
  readonly entryId: string;
  readonly rank: number;
  readonly score: string;
  readonly total: string;
  readonly data: Record<string, unknown>;
}

export interface ChainResultRow {
  readonly resultTime: number;
  /** counting, skipped, decided or cancelled. */
  readonly status: string;
  /** none, scoring or final. */
  readonly stage: string;
  /** native, or legacy for a result 6529.io made before the switch. */
  readonly origin: string;
  readonly height: number;
  readonly data: Record<string, unknown>;
}

/** A decision as the index holds it, with everything under it. */
export interface ChainDecisionState {
  readonly decision: ChainDecisionRow;
  readonly entries: readonly ChainEntryRow[];
  readonly votes: readonly ChainVoteRow[];
  /** The live leaderboard; null when the index keeps none (not published). */
  readonly board: readonly ChainBoardRow[] | null;
  readonly results: readonly ChainResultRow[];
}

// ------------------------------------------------------------ 6529.io

export interface TargetCompetition {
  readonly id: string;
  readonly waveId: string;
  readonly legacyWaveId: string | null;
  readonly type: string;
  readonly lifecycle: string;
  readonly decisionConfig: Record<string, unknown>;
  readonly outcomeConfig: readonly unknown[];
  readonly capabilities: readonly string[];
  readonly publishedAt: number | null;
  readonly endedAt: number | null;
  readonly archivedAt: number | null;
}

export interface TargetEntry {
  readonly id: string;
  readonly dropId: string;
  readonly submitterId: string;
  readonly status: string;
  readonly configVersion: number;
  readonly submittedAt: number;
  readonly withdrawnAt: number | null;
  readonly disqualifiedAt: number | null;
  readonly wonAt: number | null;
  readonly rank: number | null;
  readonly decisionId: string | null;
}

export interface TargetVote {
  readonly id: string;
  readonly entryId: string;
  readonly voterProfileId: string;
  readonly value: number;
  readonly creditSpent: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TargetRuntime {
  readonly entryId: string;
  readonly realTimeRating: number;
  readonly lastIncreasedAt: number | null;
  readonly overThresholdSince: number | null;
  readonly updatedAt: number;
}

export interface TargetBoardRow {
  readonly entryId: string;
  readonly dropId: string;
  readonly rating: number;
  readonly realTimeRating: number;
  readonly rank: number | null;
  readonly submittedAt: number;
  readonly updatedAt: number;
  readonly orderingTime: number | null;
  readonly decisionRating: number | null;
  readonly overThresholdSince: number | null;
  readonly publishedAt: number | null;
}

export interface TargetDecision {
  readonly id: string;
  readonly scheduledAt: number;
  readonly decidedAt: number | null;
  readonly status: string;
  readonly executionKey: string;
  readonly createdAt: number;
}

export interface TargetWinner {
  readonly decisionId: string;
  readonly entryId: string;
  readonly rank: number;
  readonly finalRating: number;
}

export interface TargetWinnerVote {
  readonly decisionId: string;
  readonly entryId: string;
  readonly voterProfileId: string;
  readonly value: number;
}

export interface TargetAward {
  readonly id: string;
  readonly decisionId: string;
  readonly entryId: string;
  readonly outcomePosition: number;
}

/** A row of competition_score_history (kind AGGREGATE or VOTER). */
export interface TargetScorePoint {
  readonly kind: 'AGGREGATE' | 'VOTER';
  readonly entryId: string;
  /** '' for an AGGREGATE row. */
  readonly voterProfileId: string;
  readonly value: number;
  readonly occurredAt: number;
  readonly sequence: number;
}

/** A competition with every row of it the mirror writes. */
export interface TargetCompetitionState {
  readonly competition: TargetCompetition;
  readonly entries: readonly TargetEntry[];
  readonly votes: readonly TargetVote[];
  readonly runtime: readonly TargetRuntime[];
  readonly board: readonly TargetBoardRow[];
  readonly decisions: readonly TargetDecision[];
  readonly winners: readonly TargetWinner[];
  readonly winnerVotes: readonly TargetWinnerVote[];
  readonly awards: readonly TargetAward[];
  /**
   * Score history from the time the weighted ratings need (and each
   * series' last row before it), for a time-locked decision; else none.
   */
  readonly scoreHistory: readonly TargetScorePoint[];
}

// ------------------------------------------------------------ lookups

/** A row of chain_claim_builds left skipped for want of a 6529.io drop. */
export interface SkippedClaimBuild {
  readonly network: string;
  readonly occurrence: number;
  /** The block the result went final in. */
  readonly height: number;
  readonly entryId: string;
}

/** What the planner looks up beside the two sides' rows. */
export interface MirrorLookups {
  /** The chain's network id (it names results in their execution key). */
  readonly network: string | null;
  /** The run's time: the stamp of rows it changes. */
  readonly now: number;
  /** A principal's 6529.io profile id (identity_chain_principals). */
  profileOf(principal: string): string | null;
  /**
   * Whether a profile has a principal. A row of a profile with none may be
   * a vote of a principal the identity mirror hasn't mapped yet.
   */
  hasPrincipal(profileId: string): boolean;
  /** The time of a block the event log or the gateway knows. */
  blockTime(height: number): number | null;
  /** The block time a result went final (its RESULT_FINAL event). */
  resultFinalTime(resultTime: number): number | null;
  /**
   * The decision's claim builds the index left skipped because the rank-1
   * entry was made on the chain and had no 6529.io drop then.
   */
  skippedClaimBuilds(): readonly SkippedClaimBuild[];
  /** The decision's VOTE events this run read after the cursor. */
  voteEvents(): readonly VoteEvent[];
  /**
   * The votes an entry's RELEASE events took away, by voter: what a winner
   * had at its result when the chain has released them since.
   */
  releasedVotes(entryId: string): ReadonlyMap<string, string>;
  /**
   * The checked content of an entry made on the chain that 6529.io has no
   * row of yet, or why it is held back; null when its manifest can't be
   * read yet.
   */
  nativeEntry(entryId: string): NativeEntryLookup | null;
}
