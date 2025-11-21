import { Request, Response } from 'express';
import { asyncRouter } from '../async.router';
import { ApiResponse } from '../api-response';
import { ApiTdhStats } from '../generated/models/ApiTdhStats';
import { Timer } from '../../../time';
import { tdhStatsService } from './tdh-stats.service';
import { getAuthenticationContext, maybeAuthenticatedUser } from '../auth/auth';
import { ApiTdhGlobalStats } from '../generated/models/ApiTdhGlobalStats';
import { cacheRequest } from '../request-cache';

const router = asyncRouter();

router.get(
  `/`,
  cacheRequest(),
  async function (
    req: Request<any, any, any, any>,
    res: Response<ApiResponse<ApiTdhGlobalStats>>
  ) {
    const timer = Timer.getFromRequest(req);
    const ctx = {
      timer
    };
    const stats = await tdhStatsService.getGlobalStats(ctx);
    res.send(stats);
  }
);

router.get(
  `/:identity`,
  maybeAuthenticatedUser(),
  async function (
    req: Request<
      {
        identity: string;
      },
      any,
      any,
      any
    >,
    res: Response<ApiResponse<ApiTdhStats>>
  ) {
    const timer = Timer.getFromRequest(req);
    const ctx = {
      timer,
      authenticationContext: await getAuthenticationContext(req)
    };
    const stats = await tdhStatsService.getIdentityStats(
      req.params.identity,
      ctx
    );
    res.send(stats);
  }
);

export default router;
