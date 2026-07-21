export const RELEASE_REPOSITORIES = ['frontend', 'backend'] as const;
export type ReleaseRepository = (typeof RELEASE_REPOSITORIES)[number];

export const RELEASE_LANES = ['STAGING', 'PRODUCTION'] as const;
export type ReleaseLane = (typeof RELEASE_LANES)[number];

export const RELEASE_CONTROL_SCOPES = ['ALL', 'STAGING', 'PRODUCTION'] as const;
export type ReleaseControlScope = (typeof RELEASE_CONTROL_SCOPES)[number];

export const RELEASE_BUS_MODES = [
  'OFF',
  'SHADOW',
  'STAGING',
  'PRODUCTION'
] as const;
export type ReleaseBusMode = (typeof RELEASE_BUS_MODES)[number];

export const RELEASE_CANDIDATE_STATUSES = [
  'DRAFT',
  'READY_FOR_STAGING',
  'STAGING_CLAIMED',
  'STAGING_VALIDATING',
  'STAGING_VALIDATED',
  'STAGING_FAILED',
  'READY_FOR_PRODUCTION',
  'PRODUCTION_CLAIMED',
  'PRODUCTION_VALIDATING',
  'PRODUCTION_VALIDATED',
  'BLOCKED',
  'SUPERSEDED',
  'QUARANTINED',
  'CANCELLED'
] as const;
export type ReleaseCandidateStatus =
  (typeof RELEASE_CANDIDATE_STATUSES)[number];

export const RELEASE_TRAIN_STATUSES = [
  'COLLECTING_STAGING',
  'COLLECTING_PRODUCTION',
  'FROZEN',
  'BASE_CANARY_RUNNING',
  'COMPOSING',
  'PREFLIGHTING',
  'ISOLATING_FAILURE',
  'STAGING',
  'DEPLOYING_BACKEND',
  'DEPLOYING_FRONTEND',
  'E2E_RUNNING',
  'VALIDATING_STAGING',
  'MERGING_PRODUCTION',
  'DEPLOYING_PRODUCTION',
  'DEPLOYING_BACKEND_PRODUCTION',
  'MERGING_FRONTEND_PRODUCTION',
  'DEPLOYING_FRONTEND_PRODUCTION',
  'PRODUCTION_E2E_RUNNING',
  'VALIDATING_PRODUCTION',
  'SYNCING_STAGING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'ROLLED_BACK',
  'CANCELLED'
] as const;
export type ReleaseTrainStatus = (typeof RELEASE_TRAIN_STATUSES)[number];

export const RELEASE_OPERATION_STATUSES = [
  'PENDING',
  'DISPATCHED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'AMBIGUOUS',
  'CANCELLED'
] as const;
export type ReleaseOperationStatus =
  (typeof RELEASE_OPERATION_STATUSES)[number];

export type ReleaseDependencyRequiredState =
  | 'STAGING_VALIDATED'
  | 'PRODUCTION_VALIDATED';

export type ReleaseDeployPlan = {
  readonly units: string[];
  readonly edges: ReadonlyArray<readonly [string, string]>;
};

export type ReleaseDependencyInput = {
  readonly repository: ReleaseRepository;
  readonly branch: string;
};

export type MarkReleaseReadyInput = {
  readonly repository: ReleaseRepository;
  readonly branch: string;
  readonly expected_head_sha: string;
  readonly target_lane: ReleaseLane;
  readonly dependencies: ReleaseDependencyInput[];
  readonly deploy_plan: ReleaseDeployPlan | null;
};

export type ReleaseCandidateRecord = {
  readonly id: string;
  readonly repository: ReleaseRepository;
  readonly branch_name: string;
  readonly head_sha: string;
  readonly pr_number: number | null;
  readonly status: ReleaseCandidateStatus;
  readonly staging_ready_by_github_login: string | null;
  readonly staging_ready_at: number | null;
  readonly production_ready_by_github_login: string | null;
  readonly production_ready_at: number | null;
  readonly deploy_plan_json: ReleaseDeployPlan | null;
  readonly metadata_version: number;
  readonly current_train_id: string | null;
  readonly hold_reason: string | null;
  readonly invalidated_at: number | null;
  readonly released_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly row_version: number;
};

export type ReleaseCandidateDependencyRecord = {
  readonly id: string;
  readonly candidate_id: string;
  readonly depends_on_candidate_id: string;
  readonly required_state: ReleaseDependencyRequiredState;
  readonly created_at: number;
  readonly updated_at: number;
};

export type ReleaseTrainRecord = {
  readonly id: string;
  readonly revision: number;
  readonly target_lane: ReleaseLane;
  readonly status: ReleaseTrainStatus;
  readonly cutoff_at: number | null;
  readonly frontend_base_sha: string | null;
  readonly backend_base_sha: string | null;
  readonly frontend_release_branch: string | null;
  readonly backend_release_branch: string | null;
  readonly frontend_pr_number: number | null;
  readonly backend_pr_number: number | null;
  readonly state_machine_execution_arn: string | null;
  readonly worker_version: string | null;
  readonly failure_reason: string | null;
  readonly started_at: number | null;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly row_version: number;
};
