import { PROFILE_CMS_AGENT_GRANTS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity(PROFILE_CMS_AGENT_GRANTS_TABLE)
@Index('idx_cms_agent_grant_profile_created', ['profile_id', 'created_at'])
@Index('idx_cms_agent_grant_draft', ['draft_id', 'created_at'])
export class ProfileCmsAgentGrantEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly draft_id!: string;
  @Column({ type: 'varchar', length: 128 })
  readonly package_id!: string;
  @Column({ type: 'int' })
  readonly base_version!: number;
  @Column({ type: 'varchar', length: 71 })
  readonly base_package_hash!: string;
  @Column({ type: 'varchar', length: 42 })
  readonly issued_by_wallet!: string;
  @Column({ type: 'varchar', length: 64 })
  readonly token_hash!: string;
  @Column({ type: 'varchar', length: 80 })
  readonly label!: string;
  @Column({ type: 'bigint' })
  readonly created_at!: number;
  @Column({ type: 'bigint' })
  readonly expires_at!: number;
  @Column({ type: 'bigint', nullable: true })
  readonly revoked_at!: number | null;
  @Column({ type: 'int', default: 0 })
  readonly request_count!: number;
  @Column({ type: 'int', default: 0 })
  readonly proposal_count!: number;
}
