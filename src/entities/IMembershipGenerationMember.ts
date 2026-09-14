import { MEMBERSHIP_GENERATION_MEMBERS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** See docs/membership-refresh-design.md for the publication protocol. */
@Entity(MEMBERSHIP_GENERATION_MEMBERS_TABLE)
@Index('idx_mgm_profile_run_group', ['profile_id', 'run_id', 'group_id'])
export class MembershipGenerationMemberEntity {
  @PrimaryColumn({
    type: 'varchar',
    length: 36,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly run_id!: string;

  @PrimaryColumn({
    type: 'varchar',
    length: 200,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly group_id!: string;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly profile_id!: string;
}
