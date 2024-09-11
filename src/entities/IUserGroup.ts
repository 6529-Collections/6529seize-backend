import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { USER_GROUPS_TABLE } from '../constants';

@Entity(USER_GROUPS_TABLE)
export class UserGroupEntity {
  @PrimaryColumn({ type: 'varchar', length: 200, nullable: false })
  readonly id!: string;
  @Column({ type: 'varchar', length: 200, nullable: false })
  readonly name!: string;
  @Column({ type: 'bigint', nullable: true })
  readonly cic_min!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly cic_max!: number | null;
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly cic_user!: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true })
  readonly cic_direction!: FilterDirection | null;
  @Column({ type: 'bigint', nullable: true })
  readonly rep_min!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly rep_max!: number | null;
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly rep_user!: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true })
  readonly rep_direction!: FilterDirection | null;
  @Column({ type: 'varchar', length: 200, nullable: true })
  readonly rep_category!: string | null;
  @Column({ type: 'bigint', nullable: true })
  readonly tdh_min!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly tdh_max!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly level_min!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly level_max!: number | null;
  @Column({ type: 'datetime', nullable: false })
  readonly created_at!: Date;
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly created_by!: string;
  @Column({ type: 'boolean', nullable: false })
  readonly visible!: boolean;
  @Column({ type: 'boolean' })
  readonly owns_meme!: boolean | null;
  @Column({ type: 'json', nullable: true })
  readonly owns_meme_tokens!: string | null;
  @Column({ type: 'boolean' })
  readonly owns_gradient!: boolean | null;
  @Column({ type: 'json', nullable: true })
  readonly owns_gradient_tokens!: string | null;
  @Column({ type: 'boolean' })
  readonly owns_nextgen!: boolean | null;
  @Column({ type: 'json', nullable: true })
  readonly owns_nextgen_tokens!: string | null;
  @Column({ type: 'boolean' })
  readonly owns_lab!: boolean | null;
  @Column({ type: 'json', nullable: true })
  readonly owns_lab_tokens!: string | null;
  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly profile_group_id!: string | null;
  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  readonly excluded_profile_group_id!: string | null;
  @Index('idx_user_group_is_private')
  @Column({ type: 'boolean', nullable: false, default: false })
  readonly is_private!: boolean;
}

export enum FilterDirection {
  Received = 'RECEIVED',
  Sent = 'SENT'
}
