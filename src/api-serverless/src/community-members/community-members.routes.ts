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
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { Timer } from '../../../time';

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
        only_profile_owners?: string;
      },
      any
    >,
    res: Response<ApiResponse<CommunityMemberMinimal[]>>
  ) {
    const param = req.query.param?.toLowerCase();
    const onlyProfileOwners = req.query.only_profile_owners === 'true';

    if (!param) {
      res.send([]);
    } else {
      const results =
        await profilesService.searchCommunityMemberMinimalsOfClosestMatches({
          param,
          onlyProfileOwners,
          limit: 10
        });
      res.send(results);
    }
  }
);

router.get(
  '/top',
  maybeAuthenticatedUser(),
  async (
    req: Request<any, any, any, CommunityMembersQuery, any>,
    res: Response<ApiResponse<Page<CommunityMemberOverview>>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const query = getValidatedByJoiOrThrow(
      req.query,
      CommunityMembersQuerySchema
    );
    const response = await communityMembersService.getCommunityMembersPage(
      query,
      { timer, authenticationContext }
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
    group_id: Joi.string().optional().default(null).allow(null)
  });

export default router;
