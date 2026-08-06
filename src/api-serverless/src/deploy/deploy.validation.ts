import * as Joi from 'joi';
import {
  canDeployServiceToEnvironment,
  DEFAULT_DEPLOY_REF,
  DEPLOY_SERVICES,
  isDeployEnvironment
} from '@/api/deploy/deploy.config';
import {
  RELEASE_BUS_V2_CANDIDATE_STATUSES,
  RELEASE_BUS_V2_CONTROL_SCOPES,
  RELEASE_BUS_V2_FAILURE_CLASSES,
  RELEASE_BUS_V2_REPOSITORIES
} from '@/releaseBusV2/release-bus-v2.types';
import { RELEASE_BUS_V2_PRODUCTION_AUTHORITY_CONTROLLER_IDENTITIES } from '@/releaseBusV2/release-bus-v2.config';

const GIT_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;

export type DeployTarget = 'backend' | 'frontend';

export type DeployRunsQuery = {
  target: DeployTarget;
  page: number;
  page_size: number;
};

export type DeployRefsQuery = {
  target: DeployTarget;
  q: string;
};

export const DeployDispatchBodySchema = Joi.object({
  target: Joi.string().valid('backend', 'frontend').default('backend'),
  ref: Joi.string()
    .trim()
    .min(1)
    .max(200)
    .pattern(GIT_REF_PATTERN)
    .default(DEFAULT_DEPLOY_REF),
  environment: Joi.string()
    .trim()
    .custom((value, helpers) => {
      if (!isDeployEnvironment(value)) {
        return helpers.error('any.invalid');
      }
      return value;
    })
    .required(),
  break_glass_reason: Joi.string().trim().max(1000).allow('').default(''),
  services: Joi.array()
    .items(Joi.string().valid(...DEPLOY_SERVICES))
    .min(1)
    .max(1)
    .unique()
})
  .custom((value, helpers) => {
    if (value.target === 'frontend') {
      if (value.environment !== 'prod') {
        return helpers.error('any.invalid');
      }
      if (value.services && value.services.length > 0) {
        return helpers.error('any.invalid');
      }
      return value;
    }

    if (!value.services || value.services.length === 0) {
      return helpers.error('array.min');
    }

    return value;
  })
  .required();

export const DeployRunsQuerySchema = Joi.object<DeployRunsQuery>({
  target: Joi.string().valid('backend', 'frontend').default('backend'),
  page: Joi.number().integer().min(1).max(1000).default(1),
  page_size: Joi.number().integer().min(1).max(20).default(8)
}).unknown(true);

export const DeployRefsQuerySchema = Joi.object<DeployRefsQuery>({
  target: Joi.string().valid('backend', 'frontend').default('backend'),
  q: Joi.string().allow('').max(200).default('')
}).unknown(true);

const ReleaseRepositorySchema = Joi.string().valid('frontend', 'backend');
const ReleaseBranchSchema = Joi.string()
  .trim()
  .min(1)
  .max(255)
  .pattern(GIT_REF_PATTERN);
const ReleaseShaSchema = Joi.string()
  .lowercase()
  .pattern(/^[a-f0-9]{40}$/);

const ReleaseBusV2DeployPlanSchema = Joi.object({
  units: Joi.array()
    .items(Joi.string().pattern(/^[A-Za-z0-9_-]+$/))
    .min(1)
    .max(100)
    .unique()
    .required(),
  edges: Joi.array()
    .items(
      Joi.array()
        .ordered(
          Joi.string()
            .pattern(/^[A-Za-z0-9_-]+$/)
            .required(),
          Joi.string()
            .pattern(/^[A-Za-z0-9_-]+$/)
            .required()
        )
        .length(2)
    )
    .max(500)
    .default([]),
  publish_release_notes: Joi.boolean().strict().default(true)
});

export const ReleaseBusV2CandidateBodySchema = Joi.object({
  candidate_id: Joi.string()
    .guid({ version: ['uuidv4'] })
    .optional(),
  repository: Joi.string()
    .valid(...RELEASE_BUS_V2_REPOSITORIES)
    .required(),
  pr_number: Joi.number().integer().positive().required(),
  branch_name: ReleaseBranchSchema.required(),
  expected_head_sha: ReleaseShaSchema.required(),
  deploy_plan: ReleaseBusV2DeployPlanSchema.allow(null).default(null),
  dependencies: Joi.array()
    .items(
      Joi.object({
        candidate_id: Joi.string()
          .guid({ version: ['uuidv4'] })
          .required(),
        environment: Joi.string()
          .valid('STAGING', 'PRODUCTION', 'BOTH')
          .required()
      })
    )
    .max(100)
    .unique(
      (left, right) =>
        left.candidate_id === right.candidate_id &&
        left.environment === right.environment
    )
    .default([])
}).required();

export const ReleaseBusV2CandidateActionBodySchema = Joi.object({
  expected_head_sha: ReleaseShaSchema.required(),
  expected_row_version: Joi.number().integer().positive().required()
}).required();

export const ReleaseBusV2ProductionSelectionBodySchema = Joi.object({
  candidates: Joi.array()
    .items(
      Joi.object({
        candidate_id: Joi.string()
          .guid({ version: ['uuidv4'] })
          .required(),
        expected_head_sha: ReleaseShaSchema.required(),
        expected_row_version: Joi.number().integer().positive().required()
      })
    )
    .min(1)
    .max(100)
    .unique('candidate_id')
    .required()
}).required();

export const ReleaseBusV2CurrentStagingRepairBodySchema = Joi.object({
  dry_run: Joi.boolean().default(false),
  candidates: Joi.array()
    .items(
      Joi.object({
        repository: Joi.string()
          .valid(...RELEASE_BUS_V2_REPOSITORIES)
          .required(),
        pr_number: Joi.number().integer().positive().required(),
        head_sha: ReleaseShaSchema.required()
      })
    )
    .min(1)
    .max(100)
    .unique(
      (left, right) =>
        left.repository === right.repository &&
        left.pr_number === right.pr_number &&
        left.head_sha === right.head_sha
    )
    .when('dry_run', {
      is: false,
      then: Joi.required()
    })
}).required();

const ReleaseBusV2CandidateDeregistrationCandidateVersionSchema = Joi.object({
  id: Joi.string()
    .guid({ version: ['uuidv4'] })
    .required(),
  row_version: Joi.number().integer().positive().strict().required()
});

const ReleaseBusV2CandidateDeregistrationControlVersionSchema = Joi.object({
  scope: Joi.string()
    .valid(...RELEASE_BUS_V2_CONTROL_SCOPES)
    .required(),
  paused: Joi.boolean().strict().required(),
  row_version: Joi.number().integer().positive().strict().required()
}).required();

const ReleaseBusV2CandidateDeregistrationLockVersionSchema = Joi.object({
  name: Joi.string()
    .valid('scheduler', 'staging-environment', 'production-environment')
    .required(),
  row_version: Joi.number().integer().positive().strict().required()
}).required();

const ReleaseBusV2CandidateDeregistrationStagingRefsSchema = Joi.object({
  frontend: ReleaseShaSchema.required(),
  backend: ReleaseShaSchema.required()
}).required();

export const ReleaseBusV2CandidateDeregistrationBodySchema = Joi.object({
  phase: Joi.string().valid('PREPARE', 'EXECUTE').required(),
  reason: Joi.string().trim().min(3).max(1000).required(),
  expected_plan_sha256: Joi.string()
    .pattern(/^[a-f0-9]{64}$/)
    .when('phase', {
      is: 'EXECUTE',
      then: Joi.required(),
      otherwise: Joi.forbidden()
    }),
  expected_inventory_sha256: Joi.string()
    .pattern(/^[a-f0-9]{64}$/)
    .when('phase', {
      is: 'EXECUTE',
      then: Joi.required(),
      otherwise: Joi.forbidden()
    }),
  expected_candidates: Joi.array()
    .items(ReleaseBusV2CandidateDeregistrationCandidateVersionSchema)
    .min(0)
    .max(500)
    .unique('id')
    .when('phase', {
      is: 'EXECUTE',
      then: Joi.required(),
      otherwise: Joi.forbidden()
    }),
  expected_controls: Joi.array()
    .items(ReleaseBusV2CandidateDeregistrationControlVersionSchema)
    .length(3)
    .unique('scope')
    .when('phase', {
      is: 'EXECUTE',
      then: Joi.required(),
      otherwise: Joi.forbidden()
    }),
  expected_locks: Joi.array()
    .items(ReleaseBusV2CandidateDeregistrationLockVersionSchema)
    .length(3)
    .unique('name')
    .when('phase', {
      is: 'EXECUTE',
      then: Joi.required(),
      otherwise: Joi.forbidden()
    }),
  expected_staging_state_row_version: Joi.number()
    .integer()
    .positive()
    .strict()
    .when('phase', {
      is: 'EXECUTE',
      then: Joi.required(),
      otherwise: Joi.forbidden()
    }),
  expected_staging_refs:
    ReleaseBusV2CandidateDeregistrationStagingRefsSchema.when('phase', {
      is: 'EXECUTE',
      then: Joi.required(),
      otherwise: Joi.forbidden()
    })
}).required();

export const ReleaseBusV2CandidateCancelBodySchema = Joi.object({
  expected_row_version: Joi.number().integer().positive().required()
}).required();

const ReleaseBusV2BaselineAdoptionCandidateSchema = Joi.object({
  candidate_id: Joi.string()
    .guid({ version: ['uuidv4'] })
    .required(),
  repository: ReleaseRepositorySchema.required(),
  pr_number: Joi.number().integer().positive().strict().required(),
  head_sha: ReleaseShaSchema.required(),
  row_version: Joi.number().integer().positive().strict().required()
}).unknown(false);

const ReleaseBusV2BaselineAdoptionBackendUnitSchema = Joi.object({
  service: Joi.string().valid('api').required(),
  expected_sha: ReleaseShaSchema.required()
}).unknown(false);

export const ReleaseBusV2BaselineAdoptionBodySchema = Joi.object({
  idempotency_key: Joi.string()
    .guid({ version: ['uuidv4'] })
    .required(),
  reason: Joi.string().trim().min(3).max(1000).required(),
  expires_at: Joi.number().integer().positive().strict().required(),
  expected_staging_state_row_version: Joi.number()
    .integer()
    .positive()
    .strict()
    .required(),
  expected_frontend_ref: Joi.string().valid('1a-staging').required(),
  expected_frontend_sha: ReleaseShaSchema.required(),
  expected_frontend_runtime_sha: ReleaseShaSchema.required(),
  expected_backend_ref: Joi.string().valid('1a-staging').required(),
  expected_backend_sha: ReleaseShaSchema.required(),
  expected_backend_runtime_sha: ReleaseShaSchema.required(),
  required_backend_units: Joi.array()
    .items(ReleaseBusV2BaselineAdoptionBackendUnitSchema)
    .length(1)
    .unique('service')
    .required(),
  candidates: Joi.array()
    .items(ReleaseBusV2BaselineAdoptionCandidateSchema)
    .min(0)
    .max(500)
    .unique('candidate_id')
    .unique(
      (left, right) =>
        left.repository === right.repository &&
        left.pr_number === right.pr_number &&
        left.head_sha === right.head_sha
    )
    .required()
})
  .unknown(false)
  .required();

export const ReleaseBusV2BaselineAutomaticE2EDecisionBodySchema = Joi.object({
  e2e_workflow_run_id: Joi.string()
    .pattern(/^[1-9]\d{0,19}$/)
    .required(),
  deploy_workflow_run_id: Joi.string()
    .pattern(/^[1-9]\d{0,19}$/)
    .required(),
  deployed_ref: Joi.string().valid('1a-staging').required(),
  deployed_sha: ReleaseShaSchema.required()
})
  .unknown(false)
  .required();

export const ReleaseBusV2BaselineBackendDeploymentEventBodySchema = Joi.object({
  environment: Joi.string().valid('staging').required(),
  service: Joi.string()
    .valid(...DEPLOY_SERVICES)
    .required(),
  workflow_run_id: Joi.string()
    .pattern(/^[1-9]\d{0,19}$/)
    .required(),
  workflow_run_attempt: Joi.number().integer().positive().strict().required(),
  source_ref: Joi.string().valid('1a-staging').required(),
  source_sha: ReleaseShaSchema.required(),
  status: Joi.string().valid('SUCCEEDED', 'FAILED').required()
})
  .unknown(false)
  .required();

export const ReleaseBusV2CandidateListQuerySchema = Joi.object({
  status: Joi.string().valid(...RELEASE_BUS_V2_CANDIDATE_STATUSES),
  limit: Joi.number().integer().min(1).max(500).default(100)
}).unknown(true);

export const ReleaseBusV2ControlBodySchema = Joi.object({
  scope: Joi.string()
    .valid(...RELEASE_BUS_V2_CONTROL_SCOPES)
    .required(),
  reason: Joi.string().trim().min(3).max(1000).required()
}).required();

export const ReleaseBusV2StagingTransitionBodySchema = Joi.object({
  expected_head_sha: ReleaseShaSchema.required(),
  expected_row_version: Joi.number().integer().positive().required(),
  transition: Joi.string().valid('REMOVE', 'ABSORB').required(),
  reason: Joi.string().trim().min(3).max(1000).required()
}).required();

export const ReleaseBusV2ProgressBodySchema = Joi.object({
  train_id: Joi.string()
    .guid({ version: ['uuidv4'] })
    .required(),
  operation_key: Joi.string()
    .pattern(/^rb2:[A-Za-z0-9:._-]{1,200}:a[1-9]\d{0,8}$/)
    .required(),
  workflow_run_id: Joi.string()
    .pattern(/^[1-9]\d{0,19}$/)
    .required(),
  phase: Joi.string().trim().min(1).max(100).required(),
  status: Joi.string().valid('RUNNING', 'SUCCEEDED', 'FAILED').required(),
  failure_class: Joi.string()
    .valid(...RELEASE_BUS_V2_FAILURE_CLASSES, 'INFRASTRUCTURE_TRANSIENT')
    .allow(null)
    .default(null),
  failure_phase: Joi.string().trim().max(200).allow(null).default(null),
  retryable: Joi.boolean().default(false),
  summary: Joi.object().unknown(true).allow(null).default(null),
  backend_evidence: Joi.object().unknown(true).allow(null).default(null),
  stages: Joi.array().items(Joi.object().unknown(true)).max(500).default([]),
  jest: Joi.object().unknown(true).allow(null).default(null)
})
  .unknown(true)
  .required();

export const ReleaseBusV2ManualDeploymentReadinessBodySchema = Joi.object({
  repository: ReleaseRepositorySchema.required(),
  environment: Joi.string()
    .custom((value, helpers) => {
      if (value === 'production') return 'prod';
      return ['staging', 'prod'].includes(value)
        ? value
        : helpers.error('any.only');
    })
    .required(),
  service: Joi.when('repository', {
    is: 'frontend',
    then: Joi.string().valid('frontend').required(),
    otherwise: Joi.string()
      .valid(...DEPLOY_SERVICES)
      .required()
  }),
  workflow_run_id: Joi.string()
    .pattern(/^[1-9]\d{0,19}$/)
    .required(),
  workflow_run_attempt: Joi.number()
    .integer()
    .positive()
    .max(1_000_000)
    .strict()
    .required(),
  source_ref: Joi.string()
    .trim()
    .min(1)
    .max(240)
    .pattern(/^(?!refs\/)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/)
    .required(),
  source_sha: ReleaseShaSchema.required()
})
  .custom((value, helpers) => {
    if (
      value.repository === 'backend' &&
      !canDeployServiceToEnvironment(value.service, value.environment)
    )
      return helpers.error('any.invalid');
    return value;
  })
  .unknown(false)
  .required();

const ReleaseBusV2ProductionAuthorityIdentityFields = {
  operation_id: Joi.string()
    .pattern(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,179}$/)
    .required(),
  controller_identity: Joi.string()
    .valid(...RELEASE_BUS_V2_PRODUCTION_AUTHORITY_CONTROLLER_IDENTITIES)
    .required(),
  repository: ReleaseRepositorySchema.required(),
  environment: Joi.valid('prod').required(),
  service: Joi.when('repository', {
    is: 'frontend',
    then: Joi.valid('frontend').required(),
    otherwise: Joi.string()
      .valid(...DEPLOY_SERVICES)
      .required()
  }),
  target_sha: ReleaseShaSchema.required(),
  selection_digest: Joi.valid(null).default(null)
};

const ReleaseBusV2ProductionAuthorityIdentitySchema = Joi.object(
  ReleaseBusV2ProductionAuthorityIdentityFields
)
  .custom((value, helpers) => {
    if (
      value.repository === 'backend' &&
      !canDeployServiceToEnvironment(value.service, value.environment)
    )
      return helpers.error('any.invalid');
    if (
      value.repository === 'frontend' &&
      !['frontend-production-workflow', 'deploy-hub'].includes(
        value.controller_identity
      )
    )
      return helpers.error('any.invalid');
    if (
      value.repository === 'backend' &&
      !['backend-production-workflow', 'deploy-hub'].includes(
        value.controller_identity
      )
    )
      return helpers.error('any.invalid');
    return value;
  })
  .unknown(false)
  .required();

export const ReleaseBusV2ProductionAuthorityPrepareBodySchema =
  ReleaseBusV2ProductionAuthorityIdentitySchema;

export const ReleaseBusV2ProductionAuthorityBindBodySchema =
  ReleaseBusV2ProductionAuthorityIdentitySchema.keys({
    workflow_run_id: Joi.string()
      .pattern(/^[1-9]\d{0,19}$/)
      .required(),
    workflow_run_attempt: Joi.number()
      .integer()
      .positive()
      .max(1_000_000)
      .strict()
      .required()
  })
    .unknown(false)
    .required();

export const ReleaseBusV2ProductionAuthorityAcquireBindBodySchema =
  ReleaseBusV2ProductionAuthorityBindBodySchema;

export const ReleaseBusV2ProductionAuthorityReauthorizeBodySchema =
  ReleaseBusV2ProductionAuthorityBindBodySchema.keys({
    selection_digest: Joi.string()
      .lowercase()
      .pattern(/^[a-f0-9]{64}$/)
      .required()
  })
    .unknown(false)
    .required();

export const ReleaseBusV2ProductionAuthorityCompleteBodySchema =
  ReleaseBusV2ProductionAuthorityReauthorizeBodySchema.keys({
    qualifier_workflow_run_id: Joi.string()
      .pattern(/^[1-9]\d{0,19}$/)
      .required(),
    qualifier_workflow_run_attempt: Joi.number()
      .integer()
      .positive()
      .max(1_000_000)
      .strict()
      .required(),
    evidence_digest: Joi.string()
      .lowercase()
      .pattern(/^[a-f0-9]{64}$/)
      .required()
  })
    .unknown(false)
    .required();

export const ReleaseBusV2ProductionAuthorityFailBodySchema =
  ReleaseBusV2ProductionAuthorityBindBodySchema.keys({
    selection_digest: Joi.alternatives()
      .try(
        Joi.string()
          .lowercase()
          .pattern(/^[a-f0-9]{64}$/),
        Joi.valid(null)
      )
      .default(null),
    reason_code: Joi.string()
      .valid(
        'AWS_MUTATION_FAILED',
        'WORKFLOW_FAILED',
        'ABORTED',
        'CONTROL_REVOKED',
        'LEASE_EXPIRED',
        'LEASE_LOST'
      )
      .required()
  })
    .unknown(false)
    .required();

const releaseBusAuthorizationFields = () => ({
  train_id: Joi.string()
    .guid({ version: ['uuidv4'] })
    .required(),
  workflow_run_id: Joi.string().pattern(/^\d+$/).required(),
  artifact_run_id: Joi.when('environment', {
    is: 'orchestration',
    then: Joi.valid(null).required(),
    otherwise: Joi.alternatives()
      .try(Joi.string().pattern(/^\d+$/), Joi.valid(null))
      .required()
  }),
  repository: ReleaseRepositorySchema.required(),
  environment: Joi.string()
    .valid('orchestration', 'staging', 'prod')
    .required(),
  service: Joi.string().max(100).allow(null).required(),
  expected_sha: ReleaseShaSchema.required()
});

const RELEASE_BUS_V2_OPERATION_KEY_PATTERN =
  /^rb2:[a-f0-9-]{36}:[A-Za-z0-9._:-]+:a[1-9]\d{0,8}$/;

function hasCompleteReuseEvidenceIdentity(
  value: Readonly<Record<string, unknown>>
): boolean {
  return (
    typeof value.reuse_artifact_run_id === 'string' &&
    typeof value.reuse_artifact_name === 'string' &&
    typeof value.reuse_artifact_digest === 'string' &&
    value.reuse_artifact_name ===
      `release-bus-v2-pr-${String(value.expected_sha)}`
  );
}

function hasEmptyReuseEvidenceIdentity(
  value: Readonly<Record<string, unknown>>
): boolean {
  return [
    value.reuse_artifact_run_id,
    value.reuse_artifact_name,
    value.reuse_artifact_digest
  ].every((entry) => entry === null);
}

function hasExactManifestE2EOperationKey(
  value: Readonly<Record<string, unknown>>
): boolean {
  if (
    typeof value.operation_key !== 'string' ||
    typeof value.train_id !== 'string' ||
    typeof value.environment !== 'string'
  )
    return false;
  const segments = value.operation_key.split(':');
  return (
    segments.length === 5 &&
    segments[0] === 'rb2' &&
    segments[1] === value.train_id &&
    segments[2] === 'e2e' &&
    segments[3] === value.environment &&
    /^a[1-9]\d{0,8}$/.test(segments[4])
  );
}

function hasExactBaselineAdoptionE2EOperationKey(
  value: Readonly<Record<string, unknown>>
): boolean {
  if (
    typeof value.operation_key !== 'string' ||
    typeof value.train_id !== 'string' ||
    value.environment !== 'staging'
  )
    return false;
  const segments = value.operation_key.split(':');
  return (
    segments.length === 5 &&
    segments[0] === 'rb2' &&
    segments[1] === value.train_id &&
    segments[2] === 'baseline-adoption-e2e' &&
    segments[3] === 'staging' &&
    /^a[1-9]\d{0,8}$/.test(segments[4])
  );
}

function hasExactStagingRefOperationKey(
  value: Readonly<Record<string, unknown>>
): boolean {
  if (
    value.environment !== 'staging' ||
    typeof value.operation_key !== 'string' ||
    typeof value.train_id !== 'string' ||
    typeof value.repository !== 'string'
  )
    return false;
  const segments = value.operation_key.split(':');
  return (
    segments.length === 6 &&
    segments[0] === 'rb2' &&
    segments[1] === value.train_id &&
    segments[2] === 'advance-staging' &&
    ['release', 'rollback'].includes(segments[3]) &&
    segments[4] === value.repository &&
    /^a[1-9]\d{0,8}$/.test(segments[5])
  );
}

function isValidOrchestrationEvidenceAuthorization(
  value: Readonly<Record<string, unknown>>
): boolean {
  if (value.artifact_run_id !== null || value.artifact_digest !== null)
    return false;
  if (value.candidate_evidence_mode === 'strict-single')
    return (
      value.source_ref !== null &&
      value.aggregate_candidate_evidence_digest === null &&
      hasCompleteReuseEvidenceIdentity(value)
    );
  if (value.candidate_evidence_mode === 'strict-aggregate')
    return (
      value.source_ref !== null &&
      value.aggregate_candidate_evidence_digest !== null &&
      hasEmptyReuseEvidenceIdentity(value)
    );
  return (
    value.source_ref === null &&
    value.aggregate_candidate_evidence_digest === null &&
    hasEmptyReuseEvidenceIdentity(value)
  );
}

export const ReleaseBusV2AuthorizationBodySchema = Joi.object({
  ...releaseBusAuthorizationFields(),
  operation_key: Joi.string()
    .pattern(RELEASE_BUS_V2_OPERATION_KEY_PATTERN)
    .max(180)
    .required(),
  artifact_digest: Joi.alternatives()
    .try(Joi.string().pattern(/^[a-f0-9]{64}$/), Joi.valid(null))
    .required(),
  source_ref: Joi.alternatives()
    .try(
      Joi.string()
        .pattern(/^(?!refs\/)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/)
        .max(240),
      Joi.valid(null)
    )
    .default(null),
  candidate_evidence_mode: Joi.alternatives()
    .try(
      Joi.string().valid(
        'legacy-whole-train',
        'strict-single',
        'strict-aggregate'
      ),
      Joi.valid(null)
    )
    .default(null),
  aggregate_candidate_evidence_digest: Joi.alternatives()
    .try(Joi.string().pattern(/^[a-f0-9]{64}$/), Joi.valid(null))
    .default(null),
  reuse_artifact_run_id: Joi.alternatives()
    .try(Joi.string().pattern(/^[1-9]\d{0,19}$/), Joi.valid(null))
    .default(null),
  reuse_artifact_name: Joi.alternatives()
    .try(
      Joi.string().pattern(/^release-bus-v2-pr-[a-f0-9]{40}$/),
      Joi.valid(null)
    )
    .default(null),
  reuse_artifact_digest: Joi.alternatives()
    .try(Joi.string().pattern(/^[a-f0-9]{64}$/), Joi.valid(null))
    .default(null)
})
  .custom((value, helpers) => {
    if (!value.operation_key.startsWith(`rb2:${value.train_id}:`))
      return helpers.error('any.invalid');
    if (value.environment === 'orchestration')
      return isValidOrchestrationEvidenceAuthorization(value)
        ? value
        : helpers.error('any.invalid');
    if (
      value.source_ref !== null ||
      value.candidate_evidence_mode !== null ||
      value.aggregate_candidate_evidence_digest !== null ||
      !hasEmptyReuseEvidenceIdentity(value)
    )
      return helpers.error('any.invalid');
    if (
      hasExactManifestE2EOperationKey(value) ||
      hasExactBaselineAdoptionE2EOperationKey(value)
    ) {
      return value.repository === 'frontend' &&
        value.service === null &&
        value.artifact_run_id === null &&
        value.artifact_digest !== null
        ? value
        : helpers.error('any.invalid');
    }
    if (hasExactStagingRefOperationKey(value)) {
      return value.service === null &&
        value.artifact_run_id === null &&
        value.artifact_digest === null
        ? value
        : helpers.error('any.invalid');
    }
    return value.artifact_run_id !== null && value.artifact_digest !== null
      ? value
      : helpers.error('any.invalid');
  })
  .required();
