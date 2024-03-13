import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_PAGE_SIZE,
  Page,
  PageSortDirection
} from '../page-request';
import { getValidatedByJoiOrThrow } from '../validation';
import * as Joi from 'joi';
import { ApiResponse } from '../api-response';
import {
  CommunityMemberMinimal,
  profilesService
} from '../../../profiles/profiles.service';
import {
  CommunityMemberOverview,
  CommunityMembersQuery,
  CommunityMembersSortOption
} from './community-members.types';
import { communityMembersService } from './community-members.service';

const router = asyncRouter();

router.get(
  `/`,
  async function (
    req: Request<
      any,
      any,
      any,
      {
        param: string;
      },
      any
    >,
    res: Response<ApiResponse<CommunityMemberMinimal[]>>
  ) {
    const param = req.query.param?.toLowerCase();

    if (!param) {
      res.send([]);
    } else {
      const results =
        await profilesService.searchCommunityMemberMinimalsOfClosestMatches({
          param,
          limit: 10
        });
      res.send(results);
    }
  }
);

router.get(
  '/top',
  async (
    req: Request<any, any, any, CommunityMembersQuery, any>,
    res: Response<ApiResponse<Page<CommunityMemberOverview>>>
  ) => {
    const query = getValidatedByJoiOrThrow(
      req.query,
      CommunityMembersQuerySchema
    );
    const response = await communityMembersService.getCommunityMembersPage(
      query
    );
    res.send(response);
  }
);

const CommunityMembersQuerySchema: Joi.ObjectSchema<CommunityMembersQuery> =
  Joi.object({
    sort_direction: Joi.string()
      .optional()
      .default(PageSortDirection.DESC)
      .valid(...Object.values(PageSortDirection))
      .allow(null),
    sort: Joi.string()
      .optional()
      .default(CommunityMembersSortOption.LEVEL)
      .valid(...Object.values(CommunityMembersSortOption))
      .allow(null),
    page: Joi.number().integer().min(1).optional().allow(null).default(1),
    page_size: Joi.number()
      .integer()
      .min(1)
      .max(DEFAULT_MAX_SIZE)
      .optional()
      .allow(null)
      .default(DEFAULT_PAGE_SIZE),
    curation_criteria_id: Joi.string().optional().default(null).allow(null)
  });

export default router;
