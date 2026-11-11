import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { userGroupsService } from './user-groups.service';
import { Timer } from '../../../time';
import { getGroupsUserIsEligibleForReadContext } from '@/api/waves/wave-access.helpers';

const router = asyncRouter();

router.get(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, any, any, any>,
    res: Response<ApiResponse<string[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const response = await getGroupsUserIsEligibleForReadContext(
      userGroupsService,
      { authenticationContext, timer }
    );
    res.send(response);
  }
);

export default router;
