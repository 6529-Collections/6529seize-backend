import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { USER_GROUP_MEMBERS_TABLE } from '@/constants';

/**
 * Materialized membership of a profile in a criteria-based community group.
 * Rows are maintained by the event-driven membership refresh loop (dark for
 * now: nothing reads or writes this table yet).
 */
@Entity(USER_GROUP_MEMBERS_TABLE)
@Index('idx_user_group_members_profile_group', ['profile_id', 'group_id'])
export class UserGroupMemberEntity {
  @PrimaryColumn({ type: 'varchar', length: 200, nullable: false })
  readonly group_id!: string;

  @PrimaryColumn({
    type: 'varchar',
    length: 100,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly profile_id!: string;

  // Rule-spec version the row was derived under.
  @Column({ type: 'int', nullable: false })
  readonly spec_version!: number;

  // Watermark: when the derivation observed its inputs.
  @Column({ type: 'bigint', nullable: false })
  readonly as_of_millis!: string;
}
