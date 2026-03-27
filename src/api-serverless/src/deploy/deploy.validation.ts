import * as Joi from 'joi';
import {
  DEFAULT_DEPLOY_REF,
  DEPLOY_SERVICES,
  isDeployEnvironment
} from '@/api/deploy/deploy.config';

const GIT_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;

export type DeployRunsQuery = {
  page: number;
  page_size: number;
};

export type DeployRefsQuery = {
  q: string;
};

export const DeployDispatchBodySchema = Joi.object({
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
  services: Joi.array()
    .items(Joi.string().valid(...DEPLOY_SERVICES))
    .min(1)
    .max(50)
    .unique()
    .required()
});

export const DeployRunsQuerySchema = Joi.object<DeployRunsQuery>({
  page: Joi.number().integer().min(1).max(1000).default(1),
  page_size: Joi.number().integer().min(1).max(20).default(8)
}).unknown(true);

export const DeployRefsQuerySchema = Joi.object<DeployRefsQuery>({
  q: Joi.string().allow('').max(200).default('')
}).unknown(true);
