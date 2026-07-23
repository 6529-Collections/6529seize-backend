export const RELEASE_BUS_V2_REPOSITORIES = ['frontend', 'backend'] as const;
export type ReleaseBusV2Repository =
  (typeof RELEASE_BUS_V2_REPOSITORIES)[number];

export const RELEASE_BUS_V2_LANES = [
  'STAGING',
  'PRODUCTION',
  'PRODUCTION_QUALIFICATION'
] as const;
export type ReleaseBusV2Lane = (typeof RELEASE_BUS_V2_LANES)[number];

export const RELEASE_BUS_V2_MODES = ['OFF', 'STAGING', 'PRODUCTION'] as const;
export type ReleaseBusV2Mode = (typeof RELEASE_BUS_V2_MODES)[number];

export const RELEASE_BUS_V2_CONTROL_SCOPES = [
  'ALL',
  'STAGING',
  'PRODUCTION'
] as const;
export type ReleaseBusV2ControlScope =
  (typeof RELEASE_BUS_V2_CONTROL_SCOPES)[number];

export type ReleaseBusV2DependencyEnvironment =
  | 'STAGING'
  | 'PRODUCTION'
  | 'BOTH';

export const RELEASE_BUS_V2_CANDIDATE_STATUSES = [
  'READY_FOR_STAGING',
  'STAGING_IN_TRAIN',
  'STAGING_BUILDING',
  'STAGING_DEPLOYING',
  'STAGING_DEPLOYED',
  'STAGING_VALIDATING',
  'STAGING_VALIDATED',
  'READY_FOR_PRODUCTION',
  'PRODUCTION_IN_TRAIN',
  'PRODUCTION_BUILDING_OR_QUALIFYING',
  'PRODUCTION_DEPLOYING',
  'PRODUCTION_DEPLOYED',
  'NEEDS_REBASE',
  'WAITING_FOR_DEPENDENCY',
  'SUPERSEDED',
  'FAILED',
  'CANCELLED'
] as const;
export type ReleaseBusV2CandidateStatus =
  (typeof RELEASE_BUS_V2_CANDIDATE_STATUSES)[number];

export const RELEASE_BUS_V2_TRAIN_STATUSES = [
  'CLAIMED',
  'COMPOSING',
  'PREFLIGHTING',
  'PREPARED',
  'WAITING_FOR_ENVIRONMENT',
  'DEPLOYING',
  'STAGING_DEPLOYED',
  'E2E_RUNNING',
  'STAGING_VALIDATED',
  'MERGING_PRODUCTION',
  'PRODUCTION_DEPLOYING',
  'PRODUCTION_DEPLOYED',
  'FAILED',
  'PAUSED',
  'CANCELLED'
] as const;
export type ReleaseBusV2TrainStatus =
  (typeof RELEASE_BUS_V2_TRAIN_STATUSES)[number];

export const RELEASE_BUS_V2_OPERATION_STATUSES = [
  'PENDING',
  'DISPATCHED',
  'RUNNING',
  'RETRY_WAIT',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED'
] as const;
export type ReleaseBusV2OperationStatus =
  (typeof RELEASE_BUS_V2_OPERATION_STATUSES)[number];

export const RELEASE_BUS_V2_FAILURE_CLASSES = [
  'CANDIDATE',
  'INTERACTION',
  'INFRASTRUCTURE',
  'CONTROL_PLANE',
  'DEPLOYMENT',
  'E2E'
] as const;
export type ReleaseBusV2FailureClass =
  (typeof RELEASE_BUS_V2_FAILURE_CLASSES)[number];

export type ReleaseBusV2ManifestStatus =
  | 'STAGING_DEPLOYED'
  | 'STAGING_VALIDATED'
  | 'PRODUCTION_DEPLOYED'
  | 'FAILED';

export type ReleaseBusV2DeployPlan = {
  readonly units: readonly string[];
  readonly edges: ReadonlyArray<readonly [string, string]>;
  /**
   * Defaults to true. Internal control-plane candidates may explicitly opt out
   * while ordinary product candidates continue to feed the autonomous
   * release-note pipeline.
   */
  readonly publish_release_notes?: boolean;
};

export type ReleaseBusV2PrEvidence = {
  readonly base_sha: string;
  readonly merge_sha: string;
  readonly checks_run_id: string;
  readonly checks_completed_at: number;
  readonly artifact_run_id: string | null;
  readonly artifact_name: string | null;
  readonly artifact_digest: string | null;
};

export type ReleaseBusV2CandidateRecord = {
  readonly id: string;
  readonly repository: ReleaseBusV2Repository;
  readonly pr_number: number;
  readonly branch_name: string;
  readonly head_sha: string;
  readonly requested_by: string;
  readonly status: ReleaseBusV2CandidateStatus;
  readonly deploy_plan_json: ReleaseBusV2DeployPlan | null;
  readonly pr_evidence_json: ReleaseBusV2PrEvidence | null;
  readonly current_train_id: string | null;
  readonly staging_validated_train_id: string | null;
  readonly staging_validated_manifest_id: string | null;
  readonly production_requested_at: number | null;
  readonly production_requested_by: string | null;
  readonly hold_reason: string | null;
  readonly superseded_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly row_version: number;
};

export type ReleaseBusV2TrainRecord = {
  readonly id: string;
  readonly lane: ReleaseBusV2Lane;
  readonly status: ReleaseBusV2TrainStatus;
  readonly frontend_base_sha: string | null;
  readonly backend_base_sha: string | null;
  readonly frontend_composed_sha: string | null;
  readonly backend_composed_sha: string | null;
  readonly frontend_artifact_digest: string | null;
  readonly backend_artifact_digest: string | null;
  readonly manifest_id: string | null;
  readonly parent_train_id: string | null;
  readonly qualification_identity_sha256: string | null;
  readonly qualification_train_id: string | null;
  readonly failure_class: ReleaseBusV2FailureClass | null;
  readonly failure_message: string | null;
  readonly recovery_message: string | null;
  readonly phase_started_at: number;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly row_version: number;
};

export type ReleaseBusV2OperationRecord = {
  readonly id: string;
  readonly idempotency_key: string;
  readonly train_id: string;
  readonly operation_type: string;
  readonly repository: ReleaseBusV2Repository | null;
  readonly service: string | null;
  readonly environment: string | null;
  readonly expected_sha: string | null;
  readonly artifact_digest: string | null;
  readonly external_id: string | null;
  readonly status: ReleaseBusV2OperationStatus;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly next_retry_at: number | null;
  readonly failure_class: ReleaseBusV2FailureClass | null;
  readonly failure_message: string | null;
  readonly request_json: unknown;
  readonly result_json: unknown;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly row_version: number;
};

export type ReleaseBusV2RegisterInput = {
  readonly repository: ReleaseBusV2Repository;
  readonly pr_number: number;
  readonly branch_name: string;
  readonly expected_head_sha: string;
  readonly deploy_plan: ReleaseBusV2DeployPlan | null;
  readonly dependencies: ReadonlyArray<{
    readonly candidate_id: string;
    readonly environment: ReleaseBusV2DependencyEnvironment;
  }>;
};
