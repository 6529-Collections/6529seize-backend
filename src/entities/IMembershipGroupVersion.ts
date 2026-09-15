import { MEMBERSHIP_GROUP_VERSIONS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** See docs/membership-refresh-design.md for the publication protocol. */
@Entity(MEMBERSHIP_GROUP_VERSIONS_TABLE)
@Index('idx_mgv_catalog_group', ['catalog_version', 'group_id'])
export class MembershipGroupVersionEntity {
  @PrimaryColumn({
    type: 'varchar',
    length: 200,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly group_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly catalog_version!: string;

  @Column({ type: 'boolean', nullable: false, default: false })
  readonly is_deleted!: boolean;

  @Column({ type: 'bigint', nullable: false })
  readonly updated_at_millis!: string;
}
