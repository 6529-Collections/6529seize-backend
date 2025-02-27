import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { WAVES_ARCHIVE_TABLE, WAVES_TABLE } from '../constants';

export interface WaveBaseType {
  readonly name: string;
  readonly picture: string | null;
  readonly description_drop_id: string;
  readonly created_by: string;
  readonly created_at: number;
  readonly updated_at: number | null;
  readonly admin_group_id: string | null;
  readonly voting_group_id: string | null;
  readonly voting_credit_type: WaveCreditType;
  readonly voting_credit_category: string | null;
  readonly voting_credit_creditor: string | null;
  readonly voting_signature_required: boolean;
  readonly voting_period_start: number | null;
  readonly voting_period_end: number | null;
  readonly visibility_group_id: string | null;
  readonly participation_group_id: string | null;
  readonly chat_enabled: boolean;
  readonly chat_group_id: string | null;
  readonly participation_max_applications_per_participant: number | null;
  readonly participation_required_metadata: WaveRequiredMetadataItem[];
  readonly participation_required_media: ParticipationRequiredMedia[];
  readonly participation_period_start: number | null;
  readonly participation_period_end: number | null;
  readonly type: WaveType;
  readonly winning_min_threshold: number | null;
  readonly winning_max_threshold: number | null;
  readonly max_winners: number | null;
  readonly time_lock_ms: number | null;
  readonly outcomes: string;
  readonly decisions_strategy: WaveDecisionStrategy | null;
}

export class WaveBase implements WaveBaseType {
  @Column({ type: 'varchar', length: 250, nullable: false })
  readonly name!: string;

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

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly voting_group_id!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly voting_credit_type!: WaveCreditType;

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly voting_credit_category!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly voting_credit_creditor!: string | null;

  @Column({ type: 'boolean', nullable: false })
  readonly voting_signature_required!: boolean;

  @Column({ type: 'bigint', nullable: true })
  readonly voting_period_start!: number | null;

  @Column({ type: 'bigint', nullable: true })
  readonly voting_period_end!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly visibility_group_id!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly participation_group_id!: string | null;

  @Column({ type: 'boolean', nullable: false, default: true })
  readonly chat_enabled!: boolean;

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly chat_group_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  readonly participation_max_applications_per_participant!: number | null;

  @Column({ type: 'json', nullable: false })
  readonly participation_required_metadata!: WaveRequiredMetadataItem[];

  @Column({ type: 'json', nullable: false })
  readonly participation_required_media!: ParticipationRequiredMedia[];

  @Column({ type: 'bigint', nullable: true })
  readonly participation_period_start!: number | null;

  @Column({ type: 'bigint', nullable: true })
  readonly participation_period_end!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly type!: WaveType;

  @Column({ type: 'bigint', nullable: true })
  readonly winning_min_threshold!: number | null;

  @Column({ type: 'bigint', nullable: true })
  readonly winning_max_threshold!: number | null;

  @Column({ type: 'bigint', nullable: true })
  readonly max_winners!: number | null;

  @Column({ type: 'bigint', nullable: true })
  readonly time_lock_ms!: number | null;

  @Column({ type: 'json', nullable: false })
  readonly outcomes!: string;

  @Column({ type: 'json', nullable: true })
  readonly decisions_strategy!: WaveDecisionStrategy | null;
}

@Entity(WAVES_TABLE)
export class WaveEntity extends WaveBase {
  @Column({ type: 'varchar', length: 100, unique: true, nullable: false })
  readonly id!: string;

  @PrimaryGeneratedColumn({ type: 'bigint' })
  readonly serial_no!: number;
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
  REP = 'REP'
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

export interface WaveRequiredMetadataItem {
  readonly name: string;
  readonly type: WaveRequiredMetadataItemType;
}

export enum WaveRequiredMetadataItemType {
  STRING = 'STRING',
  NUMBER = 'NUMBER'
}
