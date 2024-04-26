import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { WAVES_TABLE } from '../constants';

@Entity(WAVES_TABLE)
export class WaveEntity {
  @Column({ type: 'varchar', length: 100, unique: true, nullable: false })
  readonly id!: string;

  @PrimaryGeneratedColumn({ type: 'bigint' })
  readonly serial_no!: string;

  @Column({ type: 'varchar', length: 250, nullable: false })
  readonly name!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at!: number;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly created_by!: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly voting_scope_type!: WaveScopeType;

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly voting_scope_curation_id!: string | null;

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

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly visibility_scope_type!: WaveScopeType;

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly visibility_scope_curation_id!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly participation_scope_type!: WaveScopeType;

  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly participation_scope_curation_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  readonly participation_max_applications_per_participant!: number | null;

  @Column({ type: 'json', nullable: false })
  readonly participation_required_metadata!: string;

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
  readonly outcomes!: string | null;
}

export enum WaveScopeType {
  ALL = 'ALL',
  CURATED = 'CURATED'
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
  VOTE_TALLY_IN_RANGE = 'VOTE_TALLY_IN_RANGE',
  TOP_VOTED = 'TOP_VOTED',
  NONE = 'NONE'
}
