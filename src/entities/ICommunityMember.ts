import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { COMMUNITY_MEMBERS_TABLE } from '../constants';

@Entity(COMMUNITY_MEMBERS_TABLE)
export class CommunityMember {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  readonly consolidation_key!: string;
  @Index()
  @Column({ type: 'varchar', length: 50 })
  readonly wallet1!: string;
  @Index()
  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly wallet2!: string | null;
  @Index()
  @Column({ type: 'varchar', length: 50, nullable: true })
  readonly wallet3!: string | null;
}
