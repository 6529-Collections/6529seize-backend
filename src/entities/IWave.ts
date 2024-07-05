import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { WAVES_TABLE } from '../constants';

@Entity(WAVES_TABLE)
export class WaveEntity {
  @Column({ type: 'varchar', length: 100, unique: true, nullable: false })
  readonly id!: string;

  @PrimaryGeneratedColumn({ type: 'bigint' })
  readonly serial_no!: number;

  @Column({ type: 'varchar', length: 250, nullable: false })
  readonly name!: string;

  @Column({ type: 'text', nullable: true, default: null })
  readonly picture!: string | null;

  @Column({ type: 'text', nullable: false })
  readonly description_drop_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly created_by!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly admin_group_id!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly voting_group_id!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly voting_credit_type!: WaveCreditType;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly voting_credit_scope_type!: WaveCreditScopeType;

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

  @Column({ type: 'bigint', nullable: true })
  readonly participation_max_applications_per_participant!: number | null;

  @Column({ type: 'json', nullable: false })
  readonly participation_required_metadata!: string;

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

  @Column({ type: 'bigint', nullable: true })
  readonly wave_period_start!: number | null;

  @Column({ type: 'bigint', nullable: true })
  readonly wave_period_end!: number | null;

  @Column({ type: 'json', nullable: false })
  readonly outcomes!: string;
}

export enum WaveCreditType {
  TDH = 'TDH',
  REP = 'REP',
  UNIQUE = 'UNIQUE'
}

export enum WaveCreditScopeType {
  WAVE = 'WAVE',
  DROP = 'DROP',
  PARTICIPANT = 'PARTICIPANT'
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
