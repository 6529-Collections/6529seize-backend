import { MEMBERSHIP_REFRESH_TARGETS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { MembershipRefreshScope } from '@/membership/membership-schema.types';

/** See docs/membership-refresh-design.md for the publication protocol. */
@Entity(MEMBERSHIP_REFRESH_TARGETS_TABLE)
@Index('idx_mrt_available_scope_target', [
  'available_at_millis',
  'scope',
  'target_id'
])
@Index('idx_mrt_scope_updated_target', [
  'scope',
  'updated_at_millis',
  'target_id'
])
export class MembershipRefreshTargetEntity {
  @PrimaryColumn({ type: 'varchar', length: 20, nullable: false })
  readonly scope!: MembershipRefreshScope;

  @PrimaryColumn({
    type: 'varchar',
    length: 200,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly target_id!: string;

  @Column({ type: 'bigint', nullable: false, default: '1' })
  readonly requested_version!: string;

  @Column({ type: 'bigint', nullable: false, default: '0' })
  readonly completed_version!: string;

  @Column({
    type: 'varchar',
    length: 36,
    nullable: true,
    collation: 'utf8_bin'
  })
  readonly active_run_id!: string | null;

  @Column({ type: 'bigint', nullable: true })
  readonly available_at_millis!: string | null;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly reason!: string;

  @Column({ type: 'int', nullable: false, default: 0 })
  readonly attempts!: number;

  @Column({ type: 'text', nullable: true })
  readonly last_error!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at_millis!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at_millis!: string;
}
