import { CommunityMembersCurationCriteria } from '../api-serverless/src/community-members/community-search-criteria.types';
import { Column, Entity, PrimaryColumn } from 'typeorm';
import { COMMUNITY_MEMBERS_CURATION_CRITERIA_TABLE } from '../constants';

@Entity(COMMUNITY_MEMBERS_CURATION_CRITERIA_TABLE)
export class CommunityMembersCurationCriteriaEntity {
  @PrimaryColumn({ type: 'varchar', length: 200, nullable: false })
  readonly id!: string;
  @Column({ type: 'varchar', length: 200, nullable: false })
  readonly name!: string;
  @Column({ type: 'json', nullable: false })
  readonly criteria!: CommunityMembersCurationCriteria;
  @Column({ type: 'datetime', nullable: false })
  readonly created_at!: Date;
  @Column({ type: 'varchar', length: 100, nullable: false })
  readonly created_by!: string;
  @Column({ type: 'boolean', nullable: false })
  readonly visible!: boolean;
}
