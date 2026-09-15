import { MEMBERSHIP_SOURCE_STATES_TABLE } from '@/constants';
import { Column, Entity, PrimaryColumn } from 'typeorm';
import type {
  MembershipSourceScope,
  MembershipSourceDimension
} from '@/membership/membership-schema.types';

/** See docs/membership-refresh-design.md for the publication protocol. */
@Entity(MEMBERSHIP_SOURCE_STATES_TABLE)
export class MembershipSourceStateEntity {
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

  @Column({ type: 'bigint', nullable: false, default: '0' })
  readonly version!: string;

  @Column({ type: 'int', nullable: false, default: 0 })
  readonly active_jobs!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at_millis!: string;
}
