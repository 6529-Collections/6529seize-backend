import { PROFILE_CMS_AGENT_PROPOSALS_TABLE } from '@/constants';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity(PROFILE_CMS_AGENT_PROPOSALS_TABLE)
@Index('idx_cms_agent_proposal_idempotency', ['grant_id', 'idempotency_key'], {
  unique: true
})
@Index('idx_cms_agent_proposal_draft', ['draft_id', 'created_at'])
@Index('idx_cms_agent_proposal_quota', ['profile_id', 'created_at'])
export class ProfileCmsAgentProposalEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  readonly id!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly grant_id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly profile_id!: string;
  @Column({ type: 'varchar', length: 100 })
  readonly draft_id!: string;
  @Column({ type: 'int' })
  readonly base_version!: number;
  @Column({ type: 'varchar', length: 71 })
  readonly base_package_hash!: string;
  @Column({ type: 'varchar', length: 71 })
  readonly candidate_package_hash!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly idempotency_key!: string;
  @Column({ type: 'varchar', length: 71 })
  readonly request_hash!: string;
  @Column({ type: 'varchar', length: 1000 })
  readonly summary!: string;
  @Column({ type: 'bigint' })
  readonly created_at!: number;
  @Column({ type: 'json' })
  readonly candidate_package!: unknown;
  @Column({ type: 'varchar', length: 12, default: 'pending' })
  readonly status!: 'pending' | 'rejected' | 'applied';
  @Column({ type: 'bigint', nullable: true })
  readonly reviewed_at!: number | null;
  @Column({ type: 'varchar', length: 100, nullable: true })
  readonly result_draft_id!: string | null;
  @Column({ type: 'varchar', length: 71, nullable: true })
  readonly result_package_hash!: string | null;
}
