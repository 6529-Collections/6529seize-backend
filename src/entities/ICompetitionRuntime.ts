import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Unique
} from 'typeorm';
import {
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_EVENT_EFFECTS_TABLE,
  COMPETITION_CLAIMS_TABLE
} from '@/constants';

/** A sequence is required to order two accepted votes in the same millisecond. */
@Entity(COMPETITION_VOTE_HISTORY_TABLE)
@Index('idx_competition_vote_history_entry_time', [
  'competition_id',
  'entry_id',
  'occurred_at',
  'sequence'
])
@Index('idx_competition_vote_history_time', [
  'competition_id',
  'occurred_at',
  'sequence'
])
@Index('idx_competition_vote_history_voter', [
  'competition_id',
  'voter_profile_id'
])
export class CompetitionVoteHistoryEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  readonly sequence!: number;
  @Column({ type: 'varchar', length: 36 })
  readonly competition_id!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly entry_id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly voter_profile_id!: string;
  @Column({ type: 'bigint' })
  readonly value!: number;
  @Column({ type: 'bigint' })
  readonly previous_value!: number;
  @Column({ type: 'bigint' })
  readonly aggregate_value!: number;
  @Column({ type: 'bigint' })
  readonly credit_delta!: number;
  @Column({ type: 'bigint' })
  readonly occurred_at!: number;
}

@Entity(COMPETITION_ENTRY_RUNTIME_TABLE)
export class CompetitionEntryRuntimeEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly competition_id!: string;
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly entry_id!: string;
  @Column({ type: 'bigint', default: 0 })
  readonly real_time_rating!: number;
  @Column({ type: 'bigint', nullable: true })
  readonly last_increased_at!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly over_threshold_since!: number | null;
  @Column({ type: 'bigint' })
  readonly updated_at!: number;
}

@Entity(COMPETITION_WINNER_VOTES_TABLE)
@Index('idx_competition_winner_votes_voter', [
  'competition_id',
  'voter_profile_id'
])
export class CompetitionWinnerVoteEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly decision_id!: string;
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly entry_id!: string;
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly voter_profile_id!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly competition_id!: string;
  @Column({ type: 'bigint' })
  readonly value!: number;
}

@Entity(COMPETITION_OUTCOME_AWARDS_TABLE)
@Unique('uq_competition_outcome_award', [
  'decision_id',
  'entry_id',
  'outcome_position'
])
@Index('idx_competition_outcome_awards_competition', [
  'competition_id',
  'decision_id'
])
export class CompetitionOutcomeAwardEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly competition_id!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly decision_id!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly entry_id!: string;
  @Column({ type: 'int' })
  readonly outcome_position!: number;
  @Column({ type: 'json' })
  readonly award!: Record<string, unknown>;
  @Column({ type: 'bigint' })
  readonly created_at!: number;
}

@Entity(COMPETITION_OUTBOX_TABLE)
@Index('idx_competition_outbox_pending', [
  'delivered_at',
  'next_attempt_at',
  'lease_until'
])
export class CompetitionOutboxEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly competition_id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly wave_id!: string;
  @Column({ type: 'varchar', length: 200, unique: true })
  readonly semantic_key!: string;
  @Column({ type: 'json' })
  readonly event!: Record<string, unknown>;
  @Column({ type: 'bigint' })
  readonly created_at!: number;
  @Column({ type: 'bigint' })
  readonly next_attempt_at!: number;
  @Column({ type: 'int', default: 0 })
  readonly attempts!: number;
  @Column({ type: 'varchar', length: 36, nullable: true })
  readonly lease_token!: string | null;
  @Column({ type: 'bigint', nullable: true })
  readonly lease_until!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly delivered_at!: number | null;
}

@Entity(COMPETITION_EVENT_EFFECTS_TABLE)
@Unique('uq_competition_event_effect', ['event_id', 'effect_key'])
export class CompetitionEventEffectEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly event_id!: string;
  @Column({ type: 'varchar', length: 160 })
  readonly effect_key!: string;
  @Column({ type: 'json', nullable: true })
  readonly result!: unknown;
  @Column({ type: 'bigint', nullable: true })
  readonly completed_at!: number | null;
}

@Entity(COMPETITION_CLAIMS_TABLE)
@Unique('uq_competition_claim_entry', ['competition_id', 'entry_id'])
export class CompetitionClaimEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly drop_id!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly competition_id!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly entry_id!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly decision_id!: string;
  @Column({ type: 'bigint' })
  readonly created_at!: number;
}
