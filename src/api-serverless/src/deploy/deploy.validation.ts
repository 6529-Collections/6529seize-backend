import * as Joi from 'joi';
import {
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

export const ReleaseBusV2CandidateCancelBodySchema = Joi.object({
  expected_row_version: Joi.number().integer().positive().required()
}).required();

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

export const ReleaseBusV2AuthorizationBodySchema = Joi.object({
  ...releaseBusAuthorizationFields(),
  operation_key: Joi.string()
    .pattern(RELEASE_BUS_V2_OPERATION_KEY_PATTERN)
    .max(180)
    .required(),
  artifact_digest: Joi.alternatives()
    .try(Joi.string().pattern(/^[a-f0-9]{64}$/), Joi.valid(null))
    .required()
})
  .custom((value, helpers) => {
    if (!value.operation_key.startsWith(`rb2:${value.train_id}:`))
      return helpers.error('any.invalid');
    if (value.environment === 'orchestration') {
      return value.artifact_run_id === null && value.artifact_digest === null
        ? value
        : helpers.error('any.invalid');
    }
    const keySegments = value.operation_key.split(':');
    const isExactManifestE2E =
      keySegments.length === 5 &&
      keySegments[0] === 'rb2' &&
      keySegments[1] === value.train_id &&
      keySegments[2] === 'e2e' &&
      keySegments[3] === value.environment &&
      /^a[1-9]\d{0,8}$/.test(keySegments[4]);
    if (isExactManifestE2E) {
      return value.repository === 'frontend' &&
        value.service === null &&
        value.artifact_run_id === null &&
        value.artifact_digest !== null
        ? value
        : helpers.error('any.invalid');
    }
    return value.artifact_run_id !== null && value.artifact_digest !== null
      ? value
      : helpers.error('any.invalid');
  })
  .required();
