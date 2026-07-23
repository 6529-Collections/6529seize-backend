import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import {
  RELEASE_BUS_V2_CANDIDATES_TABLE,
  RELEASE_BUS_V2_CANDIDATE_DEPENDENCIES_TABLE,
  RELEASE_BUS_V2_CONTROLS_TABLE,
  RELEASE_BUS_V2_EVENTS_TABLE,
  RELEASE_BUS_V2_LOCKS_TABLE,
  RELEASE_BUS_V2_MANIFESTS_TABLE,
  RELEASE_BUS_V2_OPERATIONS_TABLE,
  RELEASE_BUS_V2_TRAIN_CANDIDATES_TABLE,
  RELEASE_BUS_V2_TRAINS_TABLE
} from '@/constants';
import type {
  ReleaseBusV2CandidateStatus,
  ReleaseBusV2ControlScope,
  ReleaseBusV2DependencyEnvironment,
  ReleaseBusV2FailureClass,
  ReleaseBusV2Lane,
  ReleaseBusV2ManifestStatus,
  ReleaseBusV2OperationStatus,
  ReleaseBusV2Repository,
  ReleaseBusV2TrainStatus
} from '@/releaseBusV2/release-bus-v2.types';

@Entity(RELEASE_BUS_V2_CANDIDATES_TABLE)
@Index(
  'uq_release_bus_v2_candidate_identity',
  ['repository', 'pr_number', 'head_sha'],
  {
    unique: true
  }
)
@Index('idx_release_bus_v2_candidate_queue', [
  'status',
  'production_requested_at',
  'created_at'
])
@Index('idx_release_bus_v2_candidate_pr', [
  'repository',
  'pr_number',
  'updated_at'
])
export class ReleaseBusV2CandidateEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 16 })
  readonly repository!: ReleaseBusV2Repository;
  @Column({ type: 'int' }) readonly pr_number!: number;
  @Column({ type: 'varchar', length: 255 }) readonly branch_name!: string;
  @Column({ type: 'char', length: 40 }) readonly head_sha!: string;
  @Column({ type: 'varchar', length: 100 }) readonly requested_by!: string;
  @Column({ type: 'varchar', length: 48 })
  readonly status!: ReleaseBusV2CandidateStatus;
  @Column({ type: 'json', nullable: true }) readonly deploy_plan_json!: unknown;
  @Column({ type: 'json', nullable: true }) readonly pr_evidence_json!: unknown;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly current_train_id!: string | null;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly staging_validated_train_id!: string | null;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly staging_validated_manifest_id!: string | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly production_requested_at!: number | null;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly production_requested_by!: string | null;
  @Column({ type: 'varchar', length: 1000, nullable: true, default: null })
  readonly hold_reason!: string | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly superseded_at!: number | null;
  @Column({ type: 'bigint' }) readonly created_at!: number;
  @Column({ type: 'bigint' }) readonly updated_at!: number;
  @Column({ type: 'int', default: 1 }) readonly row_version!: number;
}

@Entity(RELEASE_BUS_V2_CANDIDATE_DEPENDENCIES_TABLE)
@Index(
  'uq_release_bus_v2_dependency',
  ['candidate_id', 'prerequisite_candidate_id', 'environment'],
  {
    unique: true
  }
)
@Index('idx_release_bus_v2_dependency_target', ['prerequisite_candidate_id'])
export class ReleaseBusV2CandidateDependencyEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 36 }) readonly candidate_id!: string;
  @Column({ type: 'varchar', length: 36 })
  readonly prerequisite_candidate_id!: string;
  @Column({ type: 'varchar', length: 16 })
  readonly environment!: ReleaseBusV2DependencyEnvironment;
  @Column({ type: 'bigint' }) readonly created_at!: number;
}

@Entity(RELEASE_BUS_V2_TRAINS_TABLE)
@Index('idx_release_bus_v2_train_lane_status', ['lane', 'status', 'created_at'])
@Index('uq_release_bus_v2_train_parent', ['parent_train_id'], { unique: true })
export class ReleaseBusV2TrainEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 32 }) readonly lane!: ReleaseBusV2Lane;
  @Column({ type: 'varchar', length: 48 })
  readonly status!: ReleaseBusV2TrainStatus;
  @Column({ type: 'char', length: 40, nullable: true, default: null })
  readonly frontend_base_sha!: string | null;
  @Column({ type: 'char', length: 40, nullable: true, default: null })
  readonly backend_base_sha!: string | null;
  @Column({ type: 'char', length: 40, nullable: true, default: null })
  readonly frontend_composed_sha!: string | null;
  @Column({ type: 'char', length: 40, nullable: true, default: null })
  readonly backend_composed_sha!: string | null;
  @Column({ type: 'char', length: 64, nullable: true, default: null })
  readonly frontend_artifact_digest!: string | null;
  @Column({ type: 'char', length: 64, nullable: true, default: null })
  readonly backend_artifact_digest!: string | null;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly manifest_id!: string | null;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly parent_train_id!: string | null;
  @Column({ type: 'char', length: 64, nullable: true, default: null })
  readonly qualification_identity_sha256!: string | null;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly qualification_train_id!: string | null;
  @Column({ type: 'varchar', length: 32, nullable: true, default: null })
  readonly failure_class!: ReleaseBusV2FailureClass | null;
  @Column({ type: 'varchar', length: 2000, nullable: true, default: null })
  readonly failure_message!: string | null;
  @Column({ type: 'varchar', length: 2000, nullable: true, default: null })
  readonly recovery_message!: string | null;
  @Column({ type: 'bigint' }) readonly phase_started_at!: number;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly completed_at!: number | null;
  @Column({ type: 'bigint' }) readonly created_at!: number;
  @Column({ type: 'bigint' }) readonly updated_at!: number;
  @Column({ type: 'int', default: 1 }) readonly row_version!: number;
}

@Entity(RELEASE_BUS_V2_TRAIN_CANDIDATES_TABLE)
@Index('uq_release_bus_v2_train_candidate', ['train_id', 'candidate_id'], {
  unique: true
})
@Index('idx_release_bus_v2_train_candidate_candidate', ['candidate_id'])
export class ReleaseBusV2TrainCandidateEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 36 }) readonly train_id!: string;
  @Column({ type: 'varchar', length: 36 }) readonly candidate_id!: string;
  @Column({ type: 'int' }) readonly sequence!: number;
  @Column({ type: 'varchar', length: 32, default: 'INCLUDED' })
  readonly disposition!: string;
  @Column({ type: 'bigint' }) readonly created_at!: number;
}

@Entity(RELEASE_BUS_V2_OPERATIONS_TABLE)
@Index('uq_release_bus_v2_operation_key', ['idempotency_key'], { unique: true })
@Index('idx_release_bus_v2_operation_train_status', ['train_id', 'status'])
export class ReleaseBusV2OperationEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 220 }) readonly idempotency_key!: string;
  @Column({ type: 'varchar', length: 36 }) readonly train_id!: string;
  @Column({ type: 'varchar', length: 64 }) readonly operation_type!: string;
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  readonly repository!: ReleaseBusV2Repository | null;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly service!: string | null;
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  readonly environment!: string | null;
  @Column({ type: 'char', length: 40, nullable: true, default: null })
  readonly expected_sha!: string | null;
  @Column({ type: 'char', length: 64, nullable: true, default: null })
  readonly artifact_digest!: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true, default: null })
  readonly external_id!: string | null;
  @Column({ type: 'varchar', length: 32 })
  readonly status!: ReleaseBusV2OperationStatus;
  @Column({ type: 'int', default: 1 }) readonly attempt!: number;
  @Column({ type: 'int', default: 3 }) readonly max_attempts!: number;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly next_retry_at!: number | null;
  @Column({ type: 'varchar', length: 32, nullable: true, default: null })
  readonly failure_class!: ReleaseBusV2FailureClass | null;
  @Column({ type: 'varchar', length: 2000, nullable: true, default: null })
  readonly failure_message!: string | null;
  @Column({ type: 'json', nullable: true }) readonly request_json!: unknown;
  @Column({ type: 'json', nullable: true }) readonly result_json!: unknown;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly started_at!: number | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly completed_at!: number | null;
  @Column({ type: 'bigint' }) readonly created_at!: number;
  @Column({ type: 'bigint' }) readonly updated_at!: number;
  @Column({ type: 'int', default: 1 }) readonly row_version!: number;
}

@Entity(RELEASE_BUS_V2_LOCKS_TABLE)
export class ReleaseBusV2LockEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 }) readonly name!: string;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly owner_train_id!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly lease_owner!: string | null;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly lease_token!: string | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly heartbeat_at!: number | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly expires_at!: number | null;
  @Column({ type: 'bigint' }) readonly updated_at!: number;
  @Column({ type: 'int', default: 1 }) readonly row_version!: number;
}

@Entity(RELEASE_BUS_V2_MANIFESTS_TABLE)
@Index('uq_release_bus_v2_manifest_identity', ['identity_sha256'], {
  unique: true
})
@Index('idx_release_bus_v2_manifest_train', ['train_id'])
export class ReleaseBusV2ManifestEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 36 }) readonly train_id!: string;
  @Column({ type: 'varchar', length: 32 }) readonly lane!: ReleaseBusV2Lane;
  @Column({ type: 'char', length: 64 }) readonly identity_sha256!: string;
  @Column({ type: 'varchar', length: 32 })
  readonly status!: ReleaseBusV2ManifestStatus;
  @Column({ type: 'char', length: 40, nullable: true, default: null })
  readonly frontend_sha!: string | null;
  @Column({ type: 'char', length: 40, nullable: true, default: null })
  readonly backend_sha!: string | null;
  @Column({ type: 'char', length: 64, nullable: true, default: null })
  readonly frontend_artifact_digest!: string | null;
  @Column({ type: 'char', length: 64, nullable: true, default: null })
  readonly backend_artifact_digest!: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true, default: null })
  readonly e2e_run_id!: string | null;
  @Column({ type: 'json' }) readonly manifest_json!: unknown;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly deployed_at!: number | null;
  @Column({ type: 'bigint', nullable: true, default: null })
  readonly validated_at!: number | null;
  @Column({ type: 'bigint' }) readonly created_at!: number;
  @Column({ type: 'bigint' }) readonly updated_at!: number;
}

@Entity(RELEASE_BUS_V2_CONTROLS_TABLE)
export class ReleaseBusV2ControlEntity {
  @PrimaryColumn({ type: 'varchar', length: 16 })
  readonly scope!: ReleaseBusV2ControlScope;
  @Column({ type: 'boolean', default: true }) readonly paused!: boolean;
  @Column({ type: 'varchar', length: 1000, nullable: true, default: null })
  readonly reason!: string | null;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly github_actor!: string | null;
  @Column({ type: 'bigint' }) readonly updated_at!: number;
  @Column({ type: 'int', default: 1 }) readonly row_version!: number;
}

@Entity(RELEASE_BUS_V2_EVENTS_TABLE)
@Index('idx_release_bus_v2_event_train_created', ['train_id', 'created_at'])
@Index('idx_release_bus_v2_event_candidate_created', [
  'candidate_id',
  'created_at'
])
export class ReleaseBusV2EventEntity {
  @PrimaryColumn({ type: 'varchar', length: 36 }) readonly id!: string;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly train_id!: string | null;
  @Column({ type: 'varchar', length: 36, nullable: true, default: null })
  readonly candidate_id!: string | null;
  @Column({ type: 'varchar', length: 64 }) readonly event_type!: string;
  @Column({ type: 'varchar', length: 100, nullable: true, default: null })
  readonly github_actor!: string | null;
  @Column({ type: 'json', nullable: true }) readonly payload_json!: unknown;
  @Column({ type: 'bigint' }) readonly created_at!: number;
}
