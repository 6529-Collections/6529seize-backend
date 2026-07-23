import { Column, Entity, Index, PrimaryColumn, Unique } from 'typeorm';
import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_LIFECYCLE_EVENTS_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  COMPETITION_PARITY_OBSERVATIONS_TABLE,
  COMPETITION_PAUSES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITIONS_TABLE
} from '@/constants';

export enum CompetitionStorageMode {
  LEGACY_ADAPTER = 'LEGACY_ADAPTER',
  NATIVE = 'NATIVE'
}

export enum CompetitionExecutionMode {
  DISABLED = 'DISABLED',
  SHADOW = 'SHADOW',
  ACTIVE = 'ACTIVE'
}

export enum CompetitionType {
  RANK = 'RANK',
  APPROVE = 'APPROVE'
}

export enum CompetitionLifecycle {
  DRAFT = 'DRAFT',
  PUBLISHED = 'PUBLISHED',
  ENDED = 'ENDED',
  CANCELLED = 'CANCELLED',
  ARCHIVED = 'ARCHIVED'
}

export enum CompetitionEntryStatus {
  ACTIVE = 'ACTIVE',
  WITHDRAWN = 'WITHDRAWN',
  DISQUALIFIED = 'DISQUALIFIED',
  WINNER = 'WINNER'
}

export enum CompetitionCapability {
  MAIN_STAGE = 'MAIN_STAGE',
  CURATION = 'CURATION',
  QUORUM = 'QUORUM',
  ANNOUNCEMENTS = 'ANNOUNCEMENTS'
}

export enum CompetitionDecisionStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED'
}

export enum CompetitionParityCategory {
  CONFIG_FIELD = 'CONFIG_FIELD',
  ENTRY_MEMBERSHIP = 'ENTRY_MEMBERSHIP',
  ENTRY_STATUS = 'ENTRY_STATUS',
  PRIMARY_COMPETITION_SELECTION = 'PRIMARY_COMPETITION_SELECTION',
  CREDIT_AVAILABLE = 'CREDIT_AVAILABLE',
  CREDIT_SPEND = 'CREDIT_SPEND',
  VOTE_TOTAL = 'VOTE_TOTAL',
  LEADERBOARD_ORDER = 'LEADERBOARD_ORDER',
  LEADERBOARD_FIELD = 'LEADERBOARD_FIELD',
  DECISION_DUE_SET = 'DECISION_DUE_SET',
  WINNER_SET_OR_ORDER = 'WINNER_SET_OR_ORDER',
  OUTCOME_OR_DISTRIBUTION = 'OUTCOME_OR_DISTRIBUTION',
  PAUSE_HANDLING = 'PAUSE_HANDLING',
  CLAIM_OR_MINT_ELIGIBILITY = 'CLAIM_OR_MINT_ELIGIBILITY',
  AUTH_OR_VISIBILITY = 'AUTH_OR_VISIBILITY',
  STATUS_OR_ERROR = 'STATUS_OR_ERROR',
  SCHEMA_OR_NULLABILITY = 'SCHEMA_OR_NULLABILITY',
  PAGINATION_OR_FILTER = 'PAGINATION_OR_FILTER'
}

@Entity(COMPETITIONS_TABLE)
@Index('idx_competitions_wave_lifecycle', ['wave_id', 'lifecycle'])
@Index('idx_competitions_wave_created_id', ['wave_id', 'created_at', 'id'])
@Index('idx_competitions_participation_start', ['participation_starts_at'])
@Index('idx_competitions_voting_start', ['voting_starts_at'])
export class CompetitionEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  @Index()
  readonly wave_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, unique: true })
  readonly legacy_wave_id!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly storage_mode!: CompetitionStorageMode;

  @Column({
    type: 'varchar',
    length: 16,
    nullable: false,
    default: CompetitionExecutionMode.DISABLED
  })
  readonly execution_mode!: CompetitionExecutionMode;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly type!: CompetitionType;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly lifecycle!: CompetitionLifecycle;

  @Column({ type: 'varchar', length: 250, nullable: false })
  readonly title!: string;

  @Column({ type: 'text', nullable: true, default: null })
  readonly description!: string | null;

  @Column({ type: 'json', nullable: false })
  readonly participation_config!: Record<string, unknown>;

  @Column({ type: 'json', nullable: false })
  readonly voting_config!: Record<string, unknown>;

  @Column({ type: 'json', nullable: false })
  readonly decision_config!: Record<string, unknown>;

  @Column({ type: 'json', nullable: false })
  readonly winner_config!: Record<string, unknown>;

  @Column({ type: 'json', nullable: false })
  readonly outcome_config!: unknown[];

  @Column({ type: 'int', nullable: false, default: 1 })
  readonly config_version!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly participation_starts_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly participation_ends_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly voting_starts_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly voting_ends_at!: number | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly published_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly ended_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly cancelled_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly archived_at!: number | null;
}

@Entity(COMPETITION_CONFIG_VERSIONS_TABLE)
export class CompetitionConfigVersionEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  @Index()
  readonly competition_id!: string;

  @PrimaryColumn({ type: 'int' })
  readonly version!: number;

  @Column({ type: 'json', nullable: false })
  readonly config!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly created_by!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}

@Entity(COMPETITION_ENTRIES_TABLE)
@Unique('uq_competition_entry_drop', ['competition_id', 'drop_id'])
@Index('idx_competition_entries_competition_status', [
  'competition_id',
  'status'
])
@Index('idx_competition_entries_competition_submitted_id', [
  'competition_id',
  'submitted_at',
  'id'
])
export class CompetitionEntryEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 36, nullable: false })
  readonly competition_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  @Index()
  readonly wave_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  @Index()
  readonly drop_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  @Index()
  readonly submitter_id!: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly status!: CompetitionEntryStatus;

  @Column({ type: 'int', nullable: false })
  readonly config_version!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly submitted_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly withdrawn_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly disqualified_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly won_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly rank!: number | null;

  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly decision_id!: string | null;
}

@Entity(COMPETITION_CAPABILITIES_TABLE)
export class CompetitionCapabilityEntity {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  readonly capability!: CompetitionCapability;

  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly competition_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  @Index()
  readonly wave_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly assigned_by!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly legacy_source_wave_id!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly assigned_at!: number;
}

@Entity(COMPETITION_LIFECYCLE_EVENTS_TABLE)
@Index('idx_competition_lifecycle_events_competition_time', [
  'competition_id',
  'created_at'
])
export class CompetitionLifecycleEventEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 36, nullable: false })
  readonly competition_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  readonly previous_lifecycle!: CompetitionLifecycle | null;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly lifecycle!: CompetitionLifecycle;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly actor_id!: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  readonly reason!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}

@Entity(COMPETITION_VOTES_TABLE)
@Unique('uq_competition_vote_actor_entry', [
  'competition_id',
  'entry_id',
  'voter_profile_id'
])
@Index('idx_competition_votes_competition_voter', [
  'competition_id',
  'voter_profile_id'
])
export class CompetitionVoteEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 36, nullable: false })
  readonly competition_id!: string;

  @Column({ type: 'varchar', length: 36, nullable: false })
  readonly entry_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly voter_profile_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly value!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly credit_spent!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

@Entity(COMPETITION_LEADERBOARD_ENTRIES_TABLE)
@Index('idx_competition_leaderboard_order', [
  'competition_id',
  'rating',
  'submitted_at',
  'entry_id'
])
export class CompetitionLeaderboardEntryEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly competition_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly entry_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly drop_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly rating!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly real_time_rating!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly rank!: number | null;

  @Column({ type: 'bigint', nullable: false })
  readonly submitted_at!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at!: number;
}

@Entity(COMPETITION_DECISIONS_TABLE)
@Unique('uq_competition_decision_occurrence', [
  'competition_id',
  'scheduled_at'
])
@Index('idx_competition_decisions_competition_time', [
  'competition_id',
  'scheduled_at',
  'id'
])
export class CompetitionDecisionEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 36, nullable: false })
  readonly competition_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly scheduled_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly decided_at!: number | null;

  @Column({ type: 'varchar', length: 16, nullable: false })
  readonly status!: CompetitionDecisionStatus;

  @Column({ type: 'varchar', length: 160, nullable: false, unique: true })
  readonly execution_key!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}

@Entity(COMPETITION_DECISION_WINNERS_TABLE)
@Unique('uq_competition_decision_winner_rank', ['decision_id', 'rank'])
export class CompetitionDecisionWinnerEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly decision_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly entry_id!: string;

  @Column({ type: 'varchar', length: 36, nullable: false })
  @Index()
  readonly competition_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly rank!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly final_rating!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}

@Entity(COMPETITION_OUTCOMES_TABLE)
@Unique('uq_competition_outcome_position', ['competition_id', 'position'])
@Index('idx_competition_outcomes_competition_position', [
  'competition_id',
  'position'
])
export class CompetitionOutcomeEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 36, nullable: false })
  readonly competition_id!: string;

  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly decision_id!: string | null;

  @Column({ type: 'int', nullable: false })
  readonly position!: number;

  @Column({ type: 'int', nullable: true, default: null })
  readonly legacy_index!: number | null;

  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly type!: string;

  @Column({ type: 'varchar', length: 40, nullable: true, default: null })
  readonly subtype!: string | null;

  @Column({ type: 'text', nullable: false })
  readonly description!: string;

  @Column({ type: 'varchar', length: 20, nullable: true, default: null })
  readonly credit!: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  readonly rep_category!: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly amount!: number | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;
}

@Entity(COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE)
@Unique('uq_competition_distribution_position', ['outcome_id', 'position'])
@Index('idx_competition_distribution_outcome_position', [
  'outcome_id',
  'position'
])
export class CompetitionOutcomeDistributionItemEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 36, nullable: false })
  readonly competition_id!: string;

  @Column({ type: 'varchar', length: 36, nullable: false })
  readonly outcome_id!: string;

  @Column({ type: 'int', nullable: false })
  readonly position!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly amount!: number | null;

  @Column({ type: 'text', nullable: true, default: null })
  readonly description!: string | null;
}

@Entity(COMPETITION_PAUSES_TABLE)
@Index('idx_competition_pauses_competition_start', [
  'competition_id',
  'start_time',
  'id'
])
export class CompetitionPauseEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 36, nullable: false })
  readonly competition_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly start_time!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly end_time!: number | null;

  @Column({ type: 'text', nullable: true, default: null })
  readonly reason!: string | null;
}

@Entity(COMPETITION_PARITY_OBSERVATIONS_TABLE)
@Index('idx_competition_parity_competition_time', [
  'competition_id',
  'observed_at'
])
@Index('idx_competition_parity_category_time', ['category', 'observed_at'])
export class CompetitionParityObservationEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly wave_id!: string;

  @Column({ type: 'varchar', length: 36, nullable: false })
  readonly competition_id!: string;

  @Column({ type: 'varchar', length: 48, nullable: false })
  readonly category!: CompetitionParityCategory;

  @Column({ type: 'boolean', nullable: false })
  readonly matched!: boolean;

  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly baseline_hash!: string;

  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly candidate_hash!: string;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly baseline_storage_mode!: CompetitionStorageMode;

  @Column({ type: 'varchar', length: 32, nullable: false })
  readonly candidate_storage_mode!: CompetitionStorageMode;

  @Column({ type: 'int', nullable: false })
  readonly baseline_config_version!: number;

  @Column({ type: 'int', nullable: false })
  readonly candidate_config_version!: number;

  @Column({ type: 'varchar', length: 64, nullable: false })
  readonly source_version!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly observed_at!: number;
}
