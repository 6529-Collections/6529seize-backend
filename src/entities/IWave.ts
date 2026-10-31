import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { WAVES_ARCHIVE_TABLE, WAVES_TABLE } from '@/constants';
import type {
  NativeWaveHubParticipationConfig,
  NativeWaveHubVotingConfig
} from '@/waves/wave-hub-configuration';

export interface WaveBaseType {
  readonly hub_participation_config?: NativeWaveHubParticipationConfig | null;
  readonly hub_voting_config?: NativeWaveHubVotingConfig | null;
  readonly name: string;
  readonly parent_wave_id: string | null;
  readonly picture: string | null;
  readonly description_drop_id: string;
  readonly created_by: string;
  readonly created_at: number;
  readonly updated_at: number | null;
  readonly admin_group_id: string | null;
  readonly voting_group_id: string | null;
  readonly voting_credit_type: WaveCreditType;
  readonly voting_credit_scope: WaveCreditScope;
  readonly voting_credit_category: string | null;
  readonly voting_credit_creditor: string | null;
  readonly voting_signature_required: boolean;
  readonly participation_signature_required: boolean;
  readonly voting_period_start: number | null;
  readonly voting_period_end: number | null;
  readonly visibility_group_id: string | null;
  readonly participation_group_id: string | null;
  readonly chat_enabled: boolean;
  readonly chat_group_id: string | null;
  readonly chat_slow_mode_cooldown_ms: number | null;
  readonly chat_links_disabled: boolean;
  readonly chat_replies_open: boolean;
  readonly chat_replies_collapsed: boolean;
  readonly participation_max_applications_per_participant: number | null;
  readonly participation_required_metadata: WaveRequiredMetadataItem[];
  readonly participation_required_media: ParticipationRequiredMedia[];
  readonly submission_type: WaveSubmissionType | null;
  readonly identity_submission_strategy: WaveIdentitySubmissionStrategy | null;
  readonly identity_submission_duplicates: WaveIdentitySubmissionDuplicates | null;
  readonly participation_period_start: number | null;
  readonly participation_period_end: number | null;
  readonly type: WaveType;
  readonly winning_min_threshold: number | null;
  readonly winning_max_threshold: number | null;
  readonly winning_threshold_min_duration_ms: number;
  readonly max_winners: number | null;
  readonly max_votes_per_identity_to_drop: number | null;
  readonly time_lock_ms: number | null;
  readonly decisions_strategy: WaveDecisionStrategy | null;
  readonly participation_terms: string | null;
  readonly admin_drop_deletion_enabled: boolean;
  readonly forbid_negative_votes: boolean;
}

/** Shared physical columns; the undecorated competition fields describe the
 * permanent compatibility projection, never retired physical storage. */
export class WaveBase implements WaveBaseType {
  @Column({ type: 'json', nullable: true })
  readonly hub_participation_config?: NativeWaveHubParticipationConfig | null;

  @Column({ type: 'json', nullable: true })
  readonly hub_voting_config?: NativeWaveHubVotingConfig | null;

  @Column({ type: 'varchar', length: 250, nullable: false })
  readonly name!: string;

  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly parent_wave_id!: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  readonly picture!: string | null;

  @Column({ type: 'text', nullable: false })
  readonly description_drop_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly updated_at!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly created_by!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly admin_group_id!: string | null;

  readonly voting_group_id!: string | null;

  readonly voting_credit_type!: WaveCreditType;

  readonly voting_credit_scope!: WaveCreditScope;

  readonly voting_credit_category!: string | null;

  readonly voting_credit_creditor!: string | null;

  readonly voting_signature_required!: boolean;

  readonly voting_period_start!: number | null;

  readonly voting_period_end!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly visibility_group_id!: string | null;

  readonly participation_group_id!: string | null;

  @Column({ type: 'boolean', nullable: false, default: true })
  readonly chat_enabled!: boolean;

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly chat_group_id!: string | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly chat_slow_mode_cooldown_ms!: number | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  readonly chat_links_disabled!: boolean;

  // Lets everyone who can view the wave reply to drops, even when they are
  // outside chat_group_id. Top-level drops still require chat_group_id.
  @Column({ type: 'boolean', nullable: false, default: false })
  readonly chat_replies_open!: boolean;

  // Keeps replies out of the wave's main feed; clients show them as an
  // expandable thread under the drop they reply to.
  @Column({ type: 'boolean', nullable: false, default: false })
  readonly chat_replies_collapsed!: boolean;

  readonly participation_max_applications_per_participant!: number | null;

  readonly participation_required_metadata!: WaveRequiredMetadataItem[];

  readonly participation_required_media!: ParticipationRequiredMedia[];

  readonly submission_type!: WaveSubmissionType | null;

  readonly identity_submission_strategy!: WaveIdentitySubmissionStrategy | null;

  readonly identity_submission_duplicates!: WaveIdentitySubmissionDuplicates | null;

  readonly participation_period_start!: number | null;

  readonly participation_period_end!: number | null;

  readonly participation_signature_required!: boolean;

  readonly type!: WaveType;

  readonly winning_min_threshold!: number | null;

  readonly winning_max_threshold!: number | null;

  readonly winning_threshold_min_duration_ms!: number;

  readonly max_winners!: number | null;

  readonly max_votes_per_identity_to_drop!: number | null;

  readonly time_lock_ms!: number | null;

  readonly decisions_strategy!: WaveDecisionStrategy | null;

  readonly participation_terms!: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  readonly admin_drop_deletion_enabled!: boolean;

  readonly forbid_negative_votes!: boolean;

  @Index('idx_wave_is_direct_message')
  @Column({ type: 'boolean', nullable: true, default: null })
  readonly is_direct_message!: boolean | null;
}

@Entity(WAVES_TABLE)
@Index('idx_wave_serialno_id', ['serial_no', 'id'])
@Index(
  'idx_wave_created_dm_serial_id',
  ['created_by', 'is_direct_message', 'serial_no', 'id'],
  { synchronize: false }
)
@Index('idx_wave_parent_wave_id', ['parent_wave_id'])
@Index('idx_wave_visibility_group_id', ['visibility_group_id'])
@Index('idx_wave_admin_group_id', ['admin_group_id'])
@Index('idx_wave_chat_group_id', ['chat_group_id'])
export class WaveEntity extends WaveBase {
  @Column({ type: 'varchar', length: 100, unique: true, nullable: false })
  readonly id!: string;

  @PrimaryGeneratedColumn({ type: 'bigint' })
  readonly serial_no!: number;

  readonly next_decision_time!: number | null;
}

export interface WaveDecisionPauseEntity {
  readonly id: number;
  readonly wave_id: string;
  readonly start_time: number;
  readonly end_time: number;
  readonly reason?: string | null;
}

@Entity(WAVES_ARCHIVE_TABLE)
export class WaveArchiveEntity extends WaveBase {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  readonly archive_id!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly id!: string;

  @Column({ type: 'bigint' })
  readonly serial_no!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly archival_entry_created_at!: number;
}

export interface WaveDecisionStrategy {
  readonly first_decision_time: number;
  readonly subsequent_decisions: number[];
  readonly is_rolling: boolean;
}

export enum WaveCreditType {
  TDH = 'TDH',
  REP = 'REP',
  XTDH = 'XTDH',
  TDH_PLUS_XTDH = 'TDH_PLUS_XTDH',
  CARD_SET_TDH = 'CARD_SET_TDH'
}

export enum WaveCreditScope {
  WAVE = 'WAVE',
  DROP = 'DROP'
}

export enum WaveType {
  APPROVE = 'APPROVE',
  RANK = 'RANK',
  CHAT = 'CHAT'
}

export enum ParticipationRequiredMedia {
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
  AUDIO = 'AUDIO'
}

export enum WaveSubmissionType {
  IDENTITY = 'IDENTITY'
}

export enum WaveIdentitySubmissionStrategy {
  ONLY_MYSELF = 'ONLY_MYSELF',
  ONLY_OTHERS = 'ONLY_OTHERS',
  EVERYONE = 'EVERYONE'
}

export enum WaveIdentitySubmissionDuplicates {
  ALWAYS_ALLOW = 'ALWAYS_ALLOW',
  ALLOW_AFTER_WIN = 'ALLOW_AFTER_WIN',
  NEVER_ALLOW = 'NEVER_ALLOW'
}

export interface WaveRequiredMetadataItem {
  readonly name: string;
  readonly type: WaveRequiredMetadataItemType;
}

export enum WaveRequiredMetadataItemType {
  STRING = 'STRING',
  NUMBER = 'NUMBER'
}

export enum WaveOutcomeType {
  MANUAL = 'MANUAL',
  AUTOMATIC = 'AUTOMATIC'
}
export enum WaveOutcomeSubType {
  CREDIT_DISTRIBUTION = 'CREDIT_DISTRIBUTION'
}
export enum WaveOutcomeCredit {
  REP = 'REP',
  CIC = 'CIC'
}

export interface WaveOutcomeEntity {
  readonly wave_id: string;
  readonly wave_outcome_position: number;
  readonly type: WaveOutcomeType;
  readonly subtype: WaveOutcomeSubType | null;
  readonly description: string;
  readonly credit: WaveOutcomeCredit | null;
  readonly rep_category: string | null;
  readonly amount: number | null;
}

export interface WaveOutcomeDistributionItemEntity {
  readonly wave_id: string;
  readonly wave_outcome_position: number;
  readonly wave_outcome_distribution_item_position: number;
  readonly amount: number | null;
  readonly description: string | null;
}
