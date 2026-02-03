import { Column, Entity, PrimaryColumn } from 'typeorm';
import { PROFILE_PROXY_ACTIONS_TABLE } from '@/constants';

@Entity(PROFILE_PROXY_ACTIONS_TABLE)
export class ProfileProxyActionEntity {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  readonly id!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly proxy_id!: string;

  @Column({ type: 'varchar', length: 100 })
  readonly action_type!: ProfileProxyActionType;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly credit_amount!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly credit_spent!: number | null;

  @Column({ type: 'bigint' })
  readonly created_at!: number;

  @Column({ type: 'bigint' })
  readonly start_time!: number;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly end_time!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly accepted_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly rejected_at!: number | null;

  @Column({ type: 'bigint', nullable: true, default: null })
  readonly revoked_at!: number | null;

  @Column({ type: 'boolean', default: false })
  readonly is_active!: boolean;
}

export enum ProfileProxyActionType {
  ALLOCATE_REP = 'ALLOCATE_REP',
  ALLOCATE_CIC = 'ALLOCATE_CIC',
  CREATE_WAVE = 'CREATE_WAVE',
  READ_WAVE = 'READ_WAVE',
  CREATE_DROP_TO_WAVE = 'CREATE_DROP_TO_WAVE',
  RATE_WAVE_DROP = 'RATE_WAVE_DROP'
}
