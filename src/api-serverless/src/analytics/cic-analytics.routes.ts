import { asyncRouter } from '../async.router';
import { Request } from 'express';
import { NotFoundException } from '../../../exceptions';
import * as Joi from 'joi';
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_PAGE_SIZE,
  PageSortDirection
} from '../page-request';
import { ProfileCicAnalyticsQuery } from './cic-analytics.types';
import { getValidatedByJoiOrThrow } from '../validation';

const router = asyncRouter();

router.get(
  '/receiver-profiles',
  async (req: Request<any, any, any, ProfileCicAnalyticsQuery, any>) => {
    getValidatedByJoiOrThrow(req.query, ApiGetProfilesCicAnalyticsSchema);
    throw new NotFoundException('Endpoint is not yet implemented');
  }
);

const ApiGetProfilesCicAnalyticsSchema: Joi.ObjectSchema<ProfileCicAnalyticsQuery> =
  Joi.object({
    page: Joi.number().integer().positive().optional().default(1),
    page_size: Joi.number()
      .integer()
      .positive()
      .max(DEFAULT_MAX_SIZE)
      .optional()
      .default(DEFAULT_PAGE_SIZE),
    sort_direction: Joi.string()
      .valid(...Object.values(PageSortDirection))
      .optional()
      .default(PageSortDirection.ASC),
    sort: Joi.string().valid('cic').optional().default('cic')
  });

export default router;
