import { MEMBERSHIP_REFRESH_RUNS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type {
  MembershipRefreshScope,
  MembershipRefreshRunStatus,
  MembershipSourceVersion,
  MembershipRefreshCursor
} from '@/membership/membership-schema.types';

/** See docs/membership-refresh-design.md for the publication protocol. */
@Entity(MEMBERSHIP_REFRESH_RUNS_TABLE)
@Index('idx_mrun_target_created', ['scope', 'target_id', 'created_at_millis'])
@Index('idx_mrun_status_lease', ['status', 'lease_expires_at_millis'])
@Index('idx_mrun_status_updated_id', ['status', 'updated_at_millis', 'id'])
export class MembershipRefreshRunEntity {
  @PrimaryColumn({
    type: 'varchar',
    length: 36,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly id!: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly scope!: MembershipRefreshScope;

  @Column({
    type: 'varchar',
    length: 200,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly target_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly request_version!: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly status!: MembershipRefreshRunStatus;

  @Column({ type: 'int', nullable: false })
  readonly spec_version!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly catalog_version!: string;

  @Column({ type: 'json', nullable: false })
  readonly source_versions!: MembershipSourceVersion[];

  @Column({ type: 'json', nullable: false })
  readonly progress_cursor!: MembershipRefreshCursor;

  @Column({ type: 'bigint', nullable: false })
  readonly evaluation_time_millis!: string;

  @Column({ type: 'bigint', nullable: true })
  readonly valid_until_millis!: string | null;

  @Column({
    type: 'varchar',
    length: 36,
    nullable: true,
    collation: 'utf8_bin'
  })
  readonly lease_token!: string | null;

  @Column({ type: 'bigint', nullable: true })
  readonly lease_expires_at_millis!: string | null;

  @Column({ type: 'bigint', nullable: false, default: '0' })
  readonly checkpoint_version!: string;

  @Column({ type: 'bigint', nullable: false, default: '0' })
  readonly processed_count!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at_millis!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at_millis!: string;

  @Column({ type: 'bigint', nullable: true })
  readonly completed_at_millis!: string | null;
}
