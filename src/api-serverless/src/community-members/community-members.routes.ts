import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { getValidatedByJoiOrThrow } from '../validation';
import { ApiResponse } from '../api-response';
import { CommunityMembersQuery } from './community-members.types';
import { communityMembersService } from './community-members.service';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { Timer } from '../../../time';
import { ApiCommunityMemberMinimal } from '../generated/models/ApiCommunityMemberMinimal';
import { ApiCommunityMembersPage } from '../generated/models/ApiCommunityMembersPage';
import { identityFetcher } from '../identities/identity.fetcher';
import { CommunityMembersQuerySchema } from './community-members-query.schema';

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

export default router;
