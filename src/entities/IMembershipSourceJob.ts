import { MEMBERSHIP_SOURCE_JOBS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type {
  MembershipSourceScope,
  MembershipSourceDimension,
  MembershipSourceJobStatus,
  MembershipSourceJobProgress
} from '@/membership/membership-schema.types';

/** See docs/membership-refresh-design.md for the publication protocol. */
@Entity(MEMBERSHIP_SOURCE_JOBS_TABLE)
@Index('idx_msj_status_updated', ['status', 'updated_at_millis'])
export class MembershipSourceJobEntity {
  @PrimaryColumn({ type: 'varchar', length: 20, nullable: false })
  readonly scope!: MembershipSourceScope;

  @PrimaryColumn({
    type: 'varchar',
    length: 100,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly target_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 20, nullable: false })
  readonly dimension!: MembershipSourceDimension;

  @PrimaryColumn({
    type: 'varchar',
    length: 100,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly job_id!: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  readonly status!: MembershipSourceJobStatus;

  @Column({ type: 'json', nullable: true })
  readonly progress!: MembershipSourceJobProgress | null;

  @Column({ type: 'bigint', nullable: false })
  readonly started_version!: string;

  @Column({ type: 'bigint', nullable: true })
  readonly completed_version!: string | null;

  @Column({ type: 'bigint', nullable: false })
  readonly created_at_millis!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at_millis!: string;

  @Column({ type: 'text', nullable: true })
  readonly last_error!: string | null;
}
