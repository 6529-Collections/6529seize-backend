import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import {
  Chunk,
  DEFAULT_MAX_SIZE,
  DEFAULT_PAGE_SIZE,
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
import { CommunitySearchCriteria } from '../../../community-search/community-search-criteria.types';

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

router.post(
  '/top',
  async (
    req: Request<any, any, CommunitySearchCriteria, CommunityMembersQuery, any>,
    res: Response<ApiResponse<Chunk<CommunityMemberOverview>>>
  ) => {
    const query = getValidatedByJoiOrThrow(
      req.query,
      CommunityMembersQuerySchema
    );
    const response = await communityMembersService.getCommunityMembersChunk(
      query,
      req.body
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
      .default(DEFAULT_PAGE_SIZE)
  });

export default router;
