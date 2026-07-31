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

export const RELEASE_BUS_V2_AUTOMATION_LANES = [
  'STAGING',
  'PRODUCTION'
] as const;
export type ReleaseBusV2AutomationLane =
  (typeof RELEASE_BUS_V2_AUTOMATION_LANES)[number];

export type ReleaseBusV2LaneState = {
  readonly lane: ReleaseBusV2AutomationLane;
  readonly status: 'ON' | 'OFF';
  readonly changeable: boolean;
  readonly reason: string | null;
};

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
  'READY_FOR_CANDIDATE_EVIDENCE_PRODUCTION',
  'WAITING_FOR_PRODUCTION_REPLAN',
  'PRODUCTION_IN_TRAIN',
  'PRODUCTION_BUILDING_OR_QUALIFYING',
  'PRODUCTION_DEPLOYING',
  'PRODUCTION_DEPLOYED',
  'NEEDS_REBASE',
  'WAITING_FOR_DEPENDENCY',
  'SUPERSEDED',
  'FAILED',
  'CANCELLED',
  'DEREGISTERED'
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
  'STAGING_ROLLING_BACK',
  'STAGING_ROLLBACK_FAILED',
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
  | 'PRODUCTION_CANDIDATE_EVIDENCE_QUALIFIED'
  | 'PRODUCTION_DEPLOYED'
  | 'FAILED';

export const RELEASE_BUS_V2_STAGING_POLICIES = [
  'CUMULATIVE_ADMITTED_SET_V1',
  'RESTORE_VALIDATED_STAGING_V1',
  'ADOPT_EXACT_DEPLOYED_BASELINE_V1'
] as const;
export type ReleaseBusV2StagingPolicy =
  (typeof RELEASE_BUS_V2_STAGING_POLICIES)[number];

export const RELEASE_BUS_V2_STAGING_LIVE_STATES = [
  'NOT_LIVE',
  'LIVE',
  'DETACHED'
] as const;
export type ReleaseBusV2StagingLiveState =
  (typeof RELEASE_BUS_V2_STAGING_LIVE_STATES)[number];

export type ReleaseBusV2StagingStateStatus =
  | 'UNINITIALIZED'
  | 'LIVE'
  | 'CLEAN_MAIN'
  | 'ROLLBACK_FAILED'
  | 'DETACHED_MANUAL_OWNERSHIP';

export const RELEASE_BUS_V2_PRODUCTION_QUALIFICATION_POLICIES = [
  'CANDIDATE_STAGING_EVIDENCE_V1',
  'LEGACY_EXACT_MANIFEST_V1'
] as const;
export type ReleaseBusV2ProductionQualificationPolicy =
  (typeof RELEASE_BUS_V2_PRODUCTION_QUALIFICATION_POLICIES)[number];

export type ReleaseBusV2CandidateStagingEvidence = {
  readonly candidate_id: string;
  readonly repository: ReleaseBusV2Repository;
  readonly pr_number: number;
  readonly head_sha: string;
  readonly staging_train_id: string;
  readonly staging_manifest_id: string;
  readonly staging_manifest_identity_sha256: string;
  readonly staging_e2e_operation_id: string;
  readonly staging_e2e_run_id: string;
};

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
  /** Added for exact workflow-source audit; absent only on historical rows. */
  readonly workflow_path?: string;
  readonly base_workflow_blob_sha?: string;
  readonly merge_workflow_blob_sha?: string;
  readonly base_gate_policy_digest?: string;
  readonly merge_gate_policy_digest?: string;
  /** Historical single-digest rows are not eligible for a new train. */
  readonly gate_policy_digest?: string;
  readonly trust_mode?: 'evidence-manifest-v1' | 'legacy-exact-workflow-v0';
  readonly contributor_github_logins?: readonly string[];
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
  readonly staging_live_state?: ReleaseBusV2StagingLiveState;
  readonly staging_live_manifest_id?: string | null;
  readonly staging_admitted_at?: number | null;
  readonly staging_live_updated_at?: number | null;
  readonly staging_transition_request?: 'REMOVE' | 'ABSORB' | null;
  readonly staging_transition_requested_at?: number | null;
  readonly staging_transition_requested_by?: string | null;
  readonly staging_transition_reason?: string | null;
  readonly production_requested_at: number | null;
  readonly production_requested_by: string | null;
  readonly production_selection_id?: string | null;
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
  readonly staging_policy?: ReleaseBusV2StagingPolicy | null;
  readonly staging_baseline_manifest_id?: string | null;
  readonly staging_transition_json?: unknown;
  readonly qualification_policy?: ReleaseBusV2ProductionQualificationPolicy | null;
  readonly qualification_evidence_json?:
    | readonly ReleaseBusV2CandidateStagingEvidence[]
    | string
    | null;
  readonly failure_class: ReleaseBusV2FailureClass | null;
  readonly failure_message: string | null;
  readonly recovery_message: string | null;
  readonly phase_started_at: number;
  readonly completed_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly row_version: number;
};

export type ReleaseBusV2StagingStateRecord = {
  readonly id: 'current';
  readonly status: ReleaseBusV2StagingStateStatus;
  readonly current_manifest_id: string | null;
  readonly last_validated_manifest_id: string | null;
  readonly frontend_sha: string | null;
  readonly backend_sha: string | null;
  readonly frontend_staging_ref_sha: string | null;
  readonly backend_staging_ref_sha: string | null;
  readonly clean_main: boolean | number;
  readonly last_transition_train_id: string | null;
  readonly updated_at: number;
  readonly row_version: number;
};

export type ReleaseBusV2StagingTransition = {
  readonly actor: string;
  readonly reason?: string;
  readonly baseline_adoption_idempotency_key?: string;
  readonly baseline_adoption_intent_identity_sha256?: string;
  readonly baseline_adoption_expires_at?: number;
  readonly baseline_adoption_required_backend_units?: readonly string[];
  readonly requested_at: number;
  readonly baseline_state_version: number;
  readonly baseline_manifest_id: string | null;
  readonly baseline_frontend_sha: string | null;
  readonly baseline_backend_sha: string | null;
  readonly observed_frontend_staging_sha?: string;
  readonly observed_backend_staging_sha?: string;
  readonly new_candidate_ids?: readonly string[];
  readonly carried_candidate_ids?: readonly string[];
  readonly replaced_candidate_ids?: readonly string[];
  readonly removed_candidate_ids?: readonly string[];
  readonly absorbed_candidate_ids?: readonly string[];
  readonly rollback_parent_train_id?: string;
  readonly rollback_artifact_source_train_id?: string;
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
  /**
   * Required only for the globally-OFF operator beta. It must exactly match
   * the configured synthetic candidate allowlist.
   */
  readonly candidate_id?: string;
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
