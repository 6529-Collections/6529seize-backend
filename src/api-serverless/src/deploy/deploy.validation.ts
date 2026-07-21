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
  base_sha: ReleaseShaSchema.required(),
  environment: Joi.string()
    .valid('orchestration', 'staging', 'prod')
    .required(),
  gate_fingerprint: ReleaseBusReportDigestSchema.required(),
  workflow_sha: ReleaseShaSchema.required(),
  workflow_digest: ReleaseBusReportDigestSchema.required(),
  node_version: Joi.string().trim().min(1).max(64).required(),
  package_manager: Joi.string().trim().min(1).max(128).required(),
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
    skipped_tests: ReleaseBusReportCountSchema
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
    .default([])
}).required();

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
  summary: ReleaseBusAggregateSummarySchema.allow(null).default(null)
}).required();

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
