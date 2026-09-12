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
  release_pull_request: Joi.number()
    .integer()
    .positive()
    .allow(null)
    .default(null),
  release_group_services: Joi.string()
    .trim()
    .max(2000)
    .pattern(/^[A-Za-z0-9_,]*$/)
    .allow('')
    .default(''),
  release_note_opt_out: Joi.boolean().strict().default(false),
  services: Joi.array()
    .items(Joi.string().valid(...DEPLOY_SERVICES))
    .min(1)
    .max(1)
    .unique()
})
  .custom((value, helpers) => {
    if (
      value.release_note_opt_out &&
      (value.release_pull_request || value.release_group_services)
    ) {
      return helpers.message({
        custom: 'Internal deployments cannot include release-note metadata'
      });
    }
    if (value.environment === 'prod' && value.ref !== 'main') {
      return helpers.message({
        custom: 'Production deployments must use main'
      });
    }
    if (
      value.target === 'backend' &&
      value.environment === 'staging' &&
      value.ref !== '1a-staging'
    ) {
      return helpers.message({
        custom: 'Staging deployments must use 1a-staging'
      });
    }
    if (
      value.target === 'backend' &&
      value.environment === 'prod' &&
      !value.release_note_opt_out &&
      !value.release_pull_request
    ) {
      return helpers.message({
        custom:
          'Choose a production PR or explicitly skip release notes for an internal operation'
      });
    }
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
