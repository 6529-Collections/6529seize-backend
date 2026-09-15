import { MEMBERSHIP_PUBLICATIONS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** See docs/membership-refresh-design.md for the publication protocol. */
@Entity(MEMBERSHIP_PUBLICATIONS_TABLE)
@Index('idx_mp_run', ['run_id'])
export class MembershipPublicationEntity {
  @PrimaryColumn({
    type: 'varchar',
    length: 100,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly profile_id!: string;

  @Column({
    type: 'varchar',
    length: 36,
    nullable: false,
    collation: 'utf8_bin'
  })
  readonly run_id!: string;

  @Column({ type: 'bigint', nullable: false })
  readonly published_at_millis!: string;
}
