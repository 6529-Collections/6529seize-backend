import { FilterDirection } from '../api-serverless/src/community-members/community-search-criteria.types';
import { Column, Entity, PrimaryColumn } from 'typeorm';
import { COMMUNITY_GROUPS_TABLE } from '../constants';

@Entity(COMMUNITY_GROUPS_TABLE)
export class CommunityGroupEntity {
  @PrimaryColumn({ type: 'varchar', length: 200, nullable: false })
  readonly id!: string;
  @Column({ type: 'varchar', length: 200, nullable: false })
  readonly name!: string;
  @Column({ type: 'bigint', nullable: true })
  readonly cic_min!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly cic_max!: number | null;
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly cic_user!: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true })
  readonly cic_direction!: FilterDirection | null;
  @Column({ type: 'bigint', nullable: true })
  readonly rep_min!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly rep_max!: number | null;
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly rep_user!: string | null;
  @Column({ type: 'varchar', length: 20, nullable: true })
  readonly rep_direction!: FilterDirection | null;
  @Column({ type: 'varchar', length: 200, nullable: true })
  readonly rep_category!: string | null;
  @Column({ type: 'bigint', nullable: true })
  readonly tdh_min!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly tdh_max!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly level_min!: number | null;
  @Column({ type: 'bigint', nullable: true })
  readonly level_max!: number | null;
  @Column({ type: 'datetime', nullable: false })
  readonly created_at!: Date;
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly created_by!: string;
  @Column({ type: 'boolean', nullable: false })
  readonly visible!: boolean;
}
