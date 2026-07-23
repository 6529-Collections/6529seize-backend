import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { RELEASE_READY_DEPLOYMENTS_TABLE } from '@/constants';
import type {
  ReleaseCandidateStatus,
  ReleaseDeployPlan,
  ReleaseRepository
} from '@/releaseBus/release-bus.types';

@Entity(RELEASE_READY_DEPLOYMENTS_TABLE)
@Index(
  'uq_release_candidate_identity',
  ['repository', 'branch_name', 'head_sha'],
  {
    unique: true
  }
)
@Index('idx_release_candidate_status_ready', [
  'status',
  'staging_ready_at',
  'production_ready_at'
])
@Index('idx_release_candidate_current_train', ['current_train_id'])
export class ReleaseReadyDeploymentEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 16 })
  readonly repository!: ReleaseRepository;
  @Column({ type: 'varchar', length: 255 }) readonly branch_name!: string;
  @Column({ type: 'char', length: 40 }) readonly head_sha!: string;
  @Column({ type: 'int', nullable: true, default: null }) readonly pr_number!:
    | number
    | null;
  @Column({ type: 'varchar', length: 32 })
  readonly status!: ReleaseCandidateStatus;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly staging_ready_by_github_login!: string | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly staging_ready_at!: number | null;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly production_ready_by_github_login!: string | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly production_ready_at!: number | null;
  @Column({ type: 'json', nullable: true })
  readonly deploy_plan_json!: ReleaseDeployPlan | null;
  @Column({ type: 'boolean', default: false })
  readonly force_fresh_base_canary!: boolean;
  @Column({ type: 'int', default: 1 }) readonly metadata_version!: number;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly current_train_id!: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true, default: null })
  readonly hold_reason!: string | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly invalidated_at!: number | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly released_at!: number | null;
  @Column({ type: 'bigint' }) readonly created_at!: number;
  @Column({ type: 'bigint' }) readonly updated_at!: number;
  @Column({ type: 'int', default: 1 }) readonly row_version!: number;
}
