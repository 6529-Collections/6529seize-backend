import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_PAGE_SIZE,
  PageSortDirection
} from '../page-request';
import { getValidatedByJoiOrThrow } from '../validation';
import * as Joi from 'joi';
import { ApiResponse } from '../api-response';
import { CommunityMembersQuery } from './community-members.types';
import { communityMembersService } from './community-members.service';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { Timer } from '../../../time';
import { ApiCommunityMemberMinimal } from '../generated/models/ApiCommunityMemberMinimal';
import { ApiCommunityMembersPage } from '../generated/models/ApiCommunityMembersPage';
import { ApiCommunityMembersSortOption } from '../generated/models/ApiCommunityMembersSortOption';
import { identityFetcher } from '../identities/identity.fetcher';

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
    res: Response<ApiResponse<ApiCommunityMemberMinimal[]>>
  ) {
    const param = req.query.param?.toLowerCase();
    const onlyProfileOwners = req.query.only_profile_owners === 'true';

    if (!param) {
      res.send([]);
    } else {
      const results =
        await identityFetcher.searchCommunityMemberMinimalsOfClosestMatches({
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
    res: Response<ApiResponse<ApiCommunityMembersPage>>
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
    group_id: Joi.string().optional().default(null).allow(null)
  });

export default router;
