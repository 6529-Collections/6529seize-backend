import { MEMBERSHIP_MATERIALIZATION_STATES_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { MembershipRefreshScope } from './IMembershipRefreshRequest';

/**
 * Records successful materialization even when a profile or group has zero
 * membership rows. The production read path requires a current PROFILE state
 * before treating an empty user_group_members result as authoritative.
 */
@Entity(MEMBERSHIP_MATERIALIZATION_STATES_TABLE)
@Index('idx_mms_scope_version_as_of', ['scope', 'spec_version', 'as_of_millis'])
export class MembershipMaterializationStateEntity {
  @PrimaryColumn({ type: 'varchar', length: 10, nullable: false })
  readonly scope!: MembershipRefreshScope;

  @PrimaryColumn({
    type: 'varchar',
    length: 200,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly target_id!: string;

  @Column({ type: 'int', nullable: false })
  readonly spec_version!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly as_of_millis!: number;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at_millis!: number;
}
