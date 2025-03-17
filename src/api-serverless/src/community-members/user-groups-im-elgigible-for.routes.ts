import { asyncRouter } from '../async.router';
import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';
import { userGroupsService } from './user-groups.service';
import { Timer } from '../../../time';

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
    const response = await userGroupsService.getGroupsUserIsEligibleFor(
      authenticationContext.getActingAsId(),
      timer
    );
    res.send(response);
  }
);

export default router;
