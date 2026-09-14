import * as Joi from 'joi';
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_PAGE_SIZE,
  PageSortDirection
} from '../page-request';
import { ApiCommunityMembersSortOption } from '../generated/models/ApiCommunityMembersSortOption';
import { CommunityMembersQuery } from './community-members.types';

export const CommunityMembersQuerySchema: Joi.ObjectSchema<CommunityMembersQuery> =
  Joi.object({
    sort_direction: Joi.string()
      .optional()
      .default(PageSortDirection.DESC)
      .valid(...Object.values(PageSortDirection))
      .allow(null),
    sort: Joi.string()
      .optional()
      .default(ApiCommunityMembersSortOption.Level)
      .valid(...Object.values(ApiCommunityMembersSortOption))
      .allow(null),
    page: Joi.number().integer().min(1).optional().allow(null).default(1),
    page_size: Joi.number()
      .integer()
      .min(1)
      .max(DEFAULT_MAX_SIZE)
      .optional()
      .allow(null)
      .default(DEFAULT_PAGE_SIZE),
    group_id: Joi.string().optional().default(null).allow(null),
    param: Joi.string().trim().max(200).optional().default(null).allow(null, '')
  });
