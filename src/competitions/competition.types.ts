import {
  CompetitionCapability,
  CompetitionDecisionStatus,
  CompetitionEntryStatus,
  CompetitionExecutionMode,
  CompetitionLifecycle,
  CompetitionStorageMode,
  CompetitionType
} from '@/entities/ICompetition';

export enum CompetitionComputedPhase {
  DRAFT = 'DRAFT',
  UPCOMING = 'UPCOMING',
  PARTICIPATION_OPEN = 'PARTICIPATION_OPEN',
  VOTING_OPEN = 'VOTING_OPEN',
  DECIDING = 'DECIDING',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  ARCHIVED = 'ARCHIVED'
}

export type CompetitionParticipationConfig = {
  readonly group_id: string | null;
  readonly signature_required: boolean;
  readonly max_entries_per_participant: number | null;
  readonly required_metadata: readonly Record<string, unknown>[];
  readonly required_media: readonly string[];
  readonly submission_type: string | null;
  readonly identity_submission_strategy: string | null;
  readonly identity_submission_duplicates: string | null;
  readonly starts_at: number | null;
  readonly ends_at: number | null;
  readonly terms: string | null;
};

export type CompetitionVotingConfig = {
  readonly group_id: string | null;
  readonly credit_type: string;
  readonly credit_scope: string;
  readonly credit_category: string | null;
  readonly credit_creditor: string | null;
  readonly credit_nfts: readonly Record<string, unknown>[];
  readonly signature_required: boolean;
  readonly starts_at: number | null;
  readonly ends_at: number | null;
  readonly max_votes_per_identity_to_entry: number | null;
  readonly forbid_negative_votes: boolean;
};

export type CompetitionDecisionConfig = {
  readonly strategy: Record<string, unknown> | null;
  readonly next_decision_time: number | null;
  readonly winning_min_threshold: number | null;
  readonly winning_max_threshold: number | null;
  readonly winning_threshold_min_duration_ms: number;
  readonly max_winners: number | null;
  readonly time_lock_ms: number | null;
};

export type CompetitionWinnerConfig = {
  readonly max_winners: number | null;
  readonly winning_min_threshold: number | null;
  readonly winning_max_threshold: number | null;
  readonly winning_threshold_min_duration_ms: number;
};

export type Competition = {
  readonly id: string;
  readonly wave_id: string;
  readonly storage_mode: CompetitionStorageMode;
  readonly execution_mode: CompetitionExecutionMode;
  readonly type: CompetitionType;
  readonly lifecycle: CompetitionLifecycle;
  readonly computed_phase: CompetitionComputedPhase;
  readonly title: string;
  readonly description: string | null;
  readonly config_version: number;
  readonly participation: CompetitionParticipationConfig;
  readonly voting: CompetitionVotingConfig;
  readonly decisions: CompetitionDecisionConfig;
  readonly winners: CompetitionWinnerConfig;
  readonly outcome_config: readonly Record<string, unknown>[];
  readonly capabilities: readonly CompetitionCapability[];
  readonly created_at: number;
  readonly updated_at: number;
  readonly published_at: number | null;
  readonly ended_at: number | null;
  readonly cancelled_at: number | null;
  readonly archived_at: number | null;
};

export type CompetitionEntry = {
  readonly id: string;
  readonly wave_id: string;
  readonly competition_id: string;
  readonly drop_id: string;
  readonly submitter_id: string;
  readonly status: CompetitionEntryStatus;
  readonly config_version: number;
  readonly submitted_at: number;
  readonly rank: number | null;
  readonly won_at: number | null;
  readonly decision_id: string | null;
};

export type CompetitionConfigVersion = {
  readonly competition_id: string;
  readonly version: number;
  readonly config: Record<string, unknown>;
  readonly created_at: number;
};

export type CompetitionLeaderboardEntry = {
  readonly competition_id: string;
  readonly entry_id: string;
  readonly drop_id: string;
  readonly rating: number;
  readonly real_time_rating: number;
  readonly rank: number | null;
  readonly submitted_at: number;
};

export type CompetitionVoter = {
  readonly profile_id: string;
  readonly votes: number;
  readonly credit_spent: number;
};

export type CompetitionEntryVote = {
  readonly id: string;
  readonly entry_id: string;
  readonly voter_profile_id: string;
  readonly value: number;
  readonly credit_spent: number;
  readonly created_at: number;
  readonly updated_at: number;
};

export type CompetitionDecisionWinner = {
  readonly entry_id: string;
  readonly rank: number;
  readonly final_rating: number;
};

export type CompetitionDecision = {
  readonly id: string;
  readonly competition_id: string;
  readonly scheduled_at: number;
  readonly decided_at: number | null;
  readonly status: CompetitionDecisionStatus;
  readonly winners: readonly CompetitionDecisionWinner[];
};

export type CompetitionOutcome = {
  readonly id: string;
  readonly competition_id: string;
  readonly decision_id: string | null;
  readonly position: number;
  readonly legacy_index: number | null;
  readonly type: string;
  readonly subtype: string | null;
  readonly description: string;
  readonly credit: string | null;
  readonly rep_category: string | null;
  readonly amount: number | null;
};

export type CompetitionDistributionItem = {
  readonly id: string;
  readonly outcome_id: string;
  readonly position: number;
  readonly amount: number | null;
  readonly description: string | null;
};

export type CompetitionPause = {
  readonly id: string;
  readonly competition_id: string;
  readonly start_time: number;
  readonly end_time: number | null;
  readonly reason: string | null;
};

export type CompetitionPage<T> = {
  readonly data: readonly T[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
};

export type CompetitionPageRequest = {
  readonly offset: number;
  readonly limit: number;
  readonly direction: 'ASC' | 'DESC';
  readonly sort?: 'submitted_at' | 'rating' | 'rank';
};

export type CompetitionSnapshot = {
  readonly storage_mode: CompetitionStorageMode;
  readonly config_version: number;
  readonly configuration: unknown;
  readonly entries: unknown;
  readonly votes_and_credits: unknown;
  readonly leaderboard: unknown;
  readonly decisions_and_winners: unknown;
  readonly outcomes_and_distributions: unknown;
  readonly pauses: unknown;
  readonly capabilities: unknown;
};

export interface CompetitionReader {
  getCompetition(
    record: CompetitionRoutingRecord,
    now: number
  ): Promise<Competition>;
  listEntries(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest,
    status?: readonly CompetitionEntryStatus[],
    submitterId?: string
  ): Promise<CompetitionPage<CompetitionEntry>>;
  getEntry(
    record: CompetitionRoutingRecord,
    entryId: string
  ): Promise<CompetitionEntry | null>;
  listLeaderboard(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionLeaderboardEntry>>;
  listVoters(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest,
    entryId?: string
  ): Promise<CompetitionPage<CompetitionVoter>>;
  listEntryVotes(
    record: CompetitionRoutingRecord,
    entryId: string,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionEntryVote>>;
  listDecisions(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionDecision>>;
  listWinners(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionEntry>>;
  listOutcomes(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionOutcome>>;
  listDistribution(
    record: CompetitionRoutingRecord,
    outcomeId: string,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionDistributionItem>>;
  listPauses(
    record: CompetitionRoutingRecord,
    request: CompetitionPageRequest
  ): Promise<CompetitionPage<CompetitionPause>>;
  getSnapshot(record: CompetitionRoutingRecord): Promise<CompetitionSnapshot>;
}

export type CompetitionRoutingRecord = {
  readonly id: string;
  readonly wave_id: string;
  readonly legacy_wave_id: string | null;
  readonly storage_mode: CompetitionStorageMode;
  readonly execution_mode: CompetitionExecutionMode;
  readonly config_version?: number | string;
};
