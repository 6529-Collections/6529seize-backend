import * as Joi from 'joi';
import {
  DEFAULT_DEPLOY_REF,
  DEPLOY_SERVICES,
  isDeployEnvironment
} from '@/api/deploy/deploy.config';

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
    .max(50)
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

export const ReleaseCandidateReadyBodySchema = Joi.object({
  repository: ReleaseRepositorySchema.required(),
  branch: ReleaseBranchSchema.required(),
  expected_head_sha: ReleaseShaSchema.required(),
  target_lane: Joi.string().valid('STAGING', 'PRODUCTION').required(),
  dependencies: Joi.array()
    .items(
      Joi.object({
        repository: ReleaseRepositorySchema.required(),
        branch: ReleaseBranchSchema.required()
      })
    )
    .max(50)
    .unique((a, b) => a.repository === b.repository && a.branch === b.branch)
    .default([]),
  force_fresh_base_canary: Joi.boolean().default(false),
  deploy_plan: Joi.object({
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
      .default([])
  })
    .allow(null)
    .default(null)
}).required();

export const ReleaseCandidateListQuerySchema = Joi.object({
  status: Joi.string().valid(
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
  ),
  limit: Joi.number().integer().min(1).max(500).default(100)
}).unknown(true);

export const ReleaseBusControlBodySchema = Joi.object({
  scope: Joi.string().valid('ALL', 'STAGING', 'PRODUCTION').required(),
  reason: Joi.string().trim().min(3).max(1000).required()
}).required();

export const ReleaseBusExperimentalResetBodySchema = Joi.object({
  reset_id: Joi.string()
    .guid({ version: ['uuidv4'] })
    .required(),
  confirmation: Joi.string()
    .valid('RESET_RELEASE_BUS_EXPERIMENTAL_HISTORY')
    .required(),
  reason: Joi.string().trim().min(20).max(1000).required()
}).required();

const ReleaseBusReportPathSchema = Joi.string()
  .trim()
  .min(1)
  .max(500)
  .pattern(/^[A-Za-z0-9._@+/-]+$/)
  .custom((value, helpers) => {
    const segments = value.split('/');
    return value.startsWith('/') ||
      segments.some((segment: string) => ['', '.', '..'].includes(segment))
      ? helpers.error('any.invalid')
      : value;
  });

const ReleaseBusReportDigestSchema = Joi.string()
  .lowercase()
  .pattern(/^(?:sha256:)?[a-f0-9]{64}$/);

const ReleaseBusReportDurationSchema = Joi.number()
  .integer()
  .min(0)
  .max(24 * 60 * 60 * 1000);

const ReleaseBusReportCountSchema = Joi.number()
  .integer()
  .min(0)
  .max(10_000_000);

const ReleaseBusAggregateSummarySchema = Joi.object({
  kind: Joi.string()
    .valid('base_canary_summary', 'frontend_preflight_base_evidence_summary')
    .default('base_canary_summary'),
  base_sha: ReleaseShaSchema.required(),
  environment: Joi.string()
    .valid('orchestration', 'staging', 'prod')
    .required(),
  gate_fingerprint: ReleaseBusReportDigestSchema.required(),
  behavior_digest: ReleaseBusReportDigestSchema.allow(null).default(null),
  build_profile_digest: ReleaseBusReportDigestSchema.allow(null).default(null),
  workflow_sha: ReleaseShaSchema.required(),
  workflow_digest: ReleaseBusReportDigestSchema.required(),
  node_version: Joi.string().trim().min(1).max(64).required(),
  package_manager: Joi.string().trim().min(1).max(128).required(),
  gate_mode: Joi.string()
    .valid('legacy', 'shadow', 'sharded')
    .allow(null)
    .default(null),
  shard_count: Joi.number().integer().min(1).max(256).required(),
  summary_artifact_name: ReleaseBusReportPathSchema.required(),
  summary_artifact_digest: ReleaseBusReportDigestSchema.required(),
  phase_durations_ms: Joi.object({
    lint: ReleaseBusReportDurationSchema,
    typecheck: ReleaseBusReportDurationSchema,
    unit_tests: ReleaseBusReportDurationSchema,
    build: ReleaseBusReportDurationSchema,
    total: ReleaseBusReportDurationSchema.required()
  }).required(),
  totals: Joi.object({
    files: ReleaseBusReportCountSchema,
    test_suites: ReleaseBusReportCountSchema,
    tests: ReleaseBusReportCountSchema,
    failed_test_suites: ReleaseBusReportCountSchema.required(),
    failed_tests: ReleaseBusReportCountSchema.required(),
    skipped_tests: ReleaseBusReportCountSchema.default(0),
    skipped_test_suites: ReleaseBusReportCountSchema.default(0)
  }).required(),
  fresh_or_reused: Joi.string().valid('fresh', 'reused').required(),
  shards: Joi.array()
    .items(
      Joi.object({
        index: Joi.number().integer().min(0).max(255).required(),
        count: Joi.number().integer().min(1).max(256).required(),
        coordinate: Joi.string()
          .trim()
          .min(1)
          .max(64)
          .pattern(/^[A-Za-z0-9._:/+-]+$/)
          .required(),
        status: Joi.string()
          .valid('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED')
          .required(),
        duration_ms: ReleaseBusReportDurationSchema.required(),
        files: ReleaseBusReportCountSchema,
        test_suites: ReleaseBusReportCountSchema,
        tests: ReleaseBusReportCountSchema,
        failed_test_suites: ReleaseBusReportCountSchema.required(),
        failed_tests: ReleaseBusReportCountSchema.required()
      })
    )
    .max(256)
    .unique('index')
    .required(),
  missing_files: Joi.array()
    .items(ReleaseBusReportPathSchema)
    .max(200)
    .unique()
    .default([]),
  duplicate_files: Joi.array()
    .items(ReleaseBusReportPathSchema)
    .max(200)
    .unique()
    .default([]),
  unexpected_files: Joi.array()
    .items(ReleaseBusReportPathSchema)
    .max(200)
    .unique()
    .default([]),
  proof_origin: Joi.string().valid('fresh_preflight').allow(null).default(null),
  build_environments: Joi.array()
    .items(Joi.string().valid('staging', 'production'))
    .max(2)
    .unique()
    .default([]),
  build_coverage: Joi.alternatives()
    .try(
      Joi.object({
        authoritative_profile: Joi.string()
          .valid('SUCCEEDED', 'FAILED')
          .required(),
        compilation_count: Joi.number().integer().valid(1).required(),
        deployed_artifact_bound: Joi.boolean().required()
      }),
      Joi.object({
        base_canary_profile: Joi.string()
          .valid('SUCCEEDED', 'NOT_PROVEN', 'FAILED')
          .required(),
        deploy_artifact_profile: Joi.string()
          .valid('SUCCEEDED', 'NOT_PROVEN', 'FAILED')
          .required()
      })
    )
    .allow(null)
    .default(null),
  immutable_artifact: Joi.object({
    artifact_name: ReleaseBusReportPathSchema.required(),
    run_id: Joi.string().pattern(/^\d+$/).required(),
    source_sha: ReleaseShaSchema.required(),
    environment: Joi.string().valid('staging', 'production').required(),
    package_digest: ReleaseBusReportDigestSchema.required(),
    upload_digest: ReleaseBusReportDigestSchema.required(),
    build_profile_digest: ReleaseBusReportDigestSchema.required()
  })
    .allow(null)
    .default(null)
}).required();

const ReleaseBusBackendEvidenceSchema = Joi.object({
  schema_version: Joi.number().integer().valid(1).required(),
  kind: Joi.string().valid('release_bus_backend_preflight_evidence').required(),
  source_sha: ReleaseShaSchema.required(),
  source_tree: ReleaseShaSchema.required(),
  workflow_sha: ReleaseShaSchema.required(),
  workflow_digest: ReleaseBusReportDigestSchema.required(),
  behavior_digest: ReleaseBusReportDigestSchema.required(),
  gate_fingerprint: ReleaseBusReportDigestSchema.required(),
  component_digests: Joi.object()
    .pattern(/^[A-Za-z0-9._/-]+$/, ReleaseBusReportDigestSchema)
    .min(1)
    .max(100)
    .required(),
  node_version: Joi.string().valid('22').required(),
  package_manager: Joi.string()
    .pattern(/^npm@[A-Za-z0-9.+-]{1,122}$/)
    .required(),
  execution: Joi.string().valid('executed_exact_composed_tree').required(),
  reuse_reason: Joi.string()
    .valid('no_exact_composed_tree_evidence_selected')
    .required(),
  lint: Joi.string().valid('success').required(),
  typecheck: Joi.string().valid('success').required(),
  tests: Joi.object({
    schema_version: Joi.number().integer().valid(1).required(),
    kind: Joi.string().valid('release_bus_backend_test_evidence').required(),
    source_sha: ReleaseShaSchema.required(),
    source_tree: ReleaseShaSchema.required(),
    gate_fingerprint: ReleaseBusReportDigestSchema.required(),
    behavior_digest: ReleaseBusReportDigestSchema.required(),
    execution: Joi.string().valid('executed').required(),
    jest_max_workers: Joi.number().integer().valid(2).required(),
    expected_files: ReleaseBusReportCountSchema.required(),
    executed_files: ReleaseBusReportCountSchema.required(),
    missing_files: Joi.array()
      .items(ReleaseBusReportPathSchema)
      .length(0)
      .required(),
    unexpected_files: Joi.array()
      .items(ReleaseBusReportPathSchema)
      .length(0)
      .required(),
    duplicate_inventory_files: Joi.array()
      .items(ReleaseBusReportPathSchema)
      .length(0)
      .required(),
    duplicate_files: Joi.array()
      .items(ReleaseBusReportPathSchema)
      .length(0)
      .required(),
    duplicate_test_identities: Joi.array()
      .items(ReleaseBusReportDigestSchema)
      .length(0)
      .required(),
    malformed_test_results: Joi.number().integer().valid(0).required(),
    executed_test_results: ReleaseBusReportCountSchema.required(),
    failed_tests: Joi.number().integer().valid(0).required(),
    failed_test_suites: Joi.number().integer().valid(0).required(),
    skipped_tests: Joi.number().integer().valid(0).required(),
    skipped_test_suites: Joi.number().integer().valid(0).required(),
    total_tests: ReleaseBusReportCountSchema.required(),
    total_test_suites: ReleaseBusReportCountSchema.required(),
    status: Joi.string().valid('SUCCEEDED').required()
  }).required(),
  selected_units: Joi.array()
    .items(Joi.string().pattern(/^[A-Za-z0-9_-]+$/))
    .min(1)
    .max(100)
    .unique()
    .required(),
  package_build_count: Joi.number().integer().min(1).max(100).required(),
  package_digests: Joi.object()
    .pattern(/^[A-Za-z0-9_-]+$/, ReleaseBusReportDigestSchema)
    .min(1)
    .max(100)
    .required(),
  status: Joi.string().valid('SUCCEEDED').required(),
  artifact_digest: ReleaseBusReportDigestSchema.required()
}).custom((value, helpers) => {
  const tests = value.tests;
  const selectedUnits = [...value.selected_units].sort((a, b) =>
    a.localeCompare(b)
  );
  const packageUnits = Object.keys(value.package_digests).sort((a, b) =>
    a.localeCompare(b)
  );
  if (
    tests.source_sha !== value.source_sha ||
    tests.source_tree !== value.source_tree ||
    tests.gate_fingerprint !== value.gate_fingerprint ||
    tests.behavior_digest !== value.behavior_digest ||
    tests.expected_files <= 0 ||
    tests.total_tests <= 0 ||
    tests.total_test_suites <= 0 ||
    tests.expected_files !== tests.executed_files ||
    tests.executed_test_results !== tests.total_tests ||
    value.package_build_count !== selectedUnits.length ||
    JSON.stringify(packageUnits) !== JSON.stringify(selectedUnits)
  ) {
    return helpers.error('any.invalid');
  }
  return value;
});

export const ReleaseBusProgressReportBodySchema = Joi.object({
  train_id: Joi.string()
    .guid({ version: ['uuidv4'] })
    .required(),
  operation_key: Joi.string().max(180).required(),
  workflow_run_id: Joi.string().pattern(/^\d+$/).required(),
  phase: Joi.string()
    .valid('lint', 'typecheck', 'unit_tests', 'build', 'complete')
    .required(),
  status: Joi.string().valid('RUNNING', 'SUCCEEDED', 'FAILED').required(),
  failure_class: Joi.string()
    .valid('SOURCE', 'INFRASTRUCTURE_TRANSIENT', 'UNKNOWN')
    .allow(null)
    .default(null),
  failure_phase: Joi.string()
    .valid('dependency_install', 'gate', 'release_branch_publication')
    .allow(null)
    .default(null),
  retryable: Joi.boolean().default(false),
  stages: Joi.array()
    .items(
      Joi.object({
        name: Joi.string()
          .valid('lint', 'typecheck', 'unit_tests', 'build')
          .required(),
        status: Joi.string()
          .valid('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED')
          .required()
      })
    )
    .max(8)
    .default([]),
  jest: Joi.object({
    num_failed_test_suites: Joi.number().integer().min(0).max(10000).required(),
    num_failed_tests: Joi.number().integer().min(0).max(100000).required(),
    failing_suites: Joi.array()
      .items(Joi.string().trim().min(1).max(500))
      .max(50)
      .default([]),
    failing_tests: Joi.array()
      .items(
        Joi.object({
          suite: Joi.string().trim().min(1).max(500).required(),
          test: Joi.string().trim().min(1).max(500).required()
        })
      )
      .max(100)
      .default([])
  })
    .allow(null)
    .default(null),
  summary: ReleaseBusAggregateSummarySchema.allow(null).default(null),
  build_profile_digest: ReleaseBusReportDigestSchema.allow(null).default(null),
  backend_evidence: ReleaseBusBackendEvidenceSchema.allow(null).default(null)
})
  .custom((value, helpers) => {
    if (
      value.status !== 'FAILED' &&
      (value.failure_class !== null ||
        value.failure_phase !== null ||
        value.retryable)
    ) {
      return helpers.error('any.invalid');
    }
    if (
      value.retryable &&
      (value.failure_class !== 'INFRASTRUCTURE_TRANSIENT' ||
        !['dependency_install', 'release_branch_publication'].includes(
          value.failure_phase
        ))
    ) {
      return helpers.error('any.invalid');
    }
    return value;
  })
  .required();

// Non-orchestration deploy operations remain artifact-required. These are the
// only workflows that authorize staging/prod evidence or synchronization
// without deploying a package. The route still binds every field to the exact
// stored operation; this allowlist is an additional schema-level boundary.
const ARTIFACT_FREE_RELEASE_OPERATIONS = [
  {
    operation: 'e2e-staging',
    repository: 'frontend',
    environment: 'staging'
  },
  { operation: 'e2e-prod', repository: 'frontend', environment: 'prod' },
  {
    operation: 'sync-staging-frontend',
    repository: 'frontend',
    environment: 'staging'
  },
  {
    operation: 'sync-staging-backend',
    repository: 'backend',
    environment: 'staging'
  }
] as const;

const RELEASE_OPERATION_KEY_PATTERN =
  /^rb:[A-Za-z0-9._-]+:r[1-9][0-9]*:([A-Za-z0-9._-]{1,48}):[a-f0-9]{32}:a[1-9][0-9]*$/;

export const ReleaseBusAuthorizationBodySchema = Joi.object({
  train_id: Joi.string()
    .guid({ version: ['uuidv4'] })
    .required(),
  operation_key: Joi.string().max(180).required(),
  workflow_run_id: Joi.string()
    .pattern(/^[0-9]+$/)
    .required(),
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
  expected_sha: ReleaseShaSchema.required(),
  artifact_digest: Joi.when('artifact_run_id', {
    is: null,
    then: Joi.valid(null).required(),
    otherwise: Joi.string()
      .pattern(/^[a-f0-9]{64}$/)
      .required()
  })
})
  .custom((value, helpers) => {
    if (
      value.environment === 'orchestration' ||
      value.artifact_run_id !== null
    ) {
      return value;
    }
    const operation = RELEASE_OPERATION_KEY_PATTERN.exec(
      value.operation_key
    )?.[1];
    const artifactFreeOperation = ARTIFACT_FREE_RELEASE_OPERATIONS.find(
      (candidate) => candidate.operation === operation
    );
    if (
      !artifactFreeOperation ||
      artifactFreeOperation.repository !== value.repository ||
      artifactFreeOperation.environment !== value.environment ||
      value.service !== null
    ) {
      return helpers.error('any.invalid');
    }
    return value;
  })
  .required();

export const ReleaseBusBreakGlassAuthorizationBodySchema = Joi.object({
  workflow_run_id: Joi.string().pattern(/^\d+$/).required(),
  repository: ReleaseRepositorySchema.required(),
  environment: Joi.string().valid('staging', 'prod').required(),
  service: Joi.string().max(100).allow(null).required(),
  expected_sha: ReleaseShaSchema.required(),
  reason: Joi.string().trim().min(3).max(1000).required()
}).required();
