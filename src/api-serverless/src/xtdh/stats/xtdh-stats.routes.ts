import { Request, Response } from 'express';
import { asyncRouter } from '../../async.router';
import { ApiResponse } from '../../api-response';
import { Timer } from '../../../../time';
import { xTdhStatsService } from './xtdh-stats.service';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser
} from '../../auth/auth';
import { cacheRequest } from '../../request-cache';
import { ApiXTdhGlobalStats } from '../../generated/models/ApiXTdhGlobalStats';
import { ApiXTdhStats } from '../../generated/models/ApiXTdhStats';

const router = asyncRouter();

router.get(
  `/`,
  cacheRequest(),
  async function (
    req: Request<any, any, any, any>,
    res: Response<ApiResponse<ApiXTdhGlobalStats>>
  ) {
    const timer = Timer.getFromRequest(req);
    const ctx = {
      timer
    };
    const stats = await xTdhStatsService.getGlobalStats(ctx);
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
    res: Response<ApiResponse<ApiXTdhStats>>
  ) {
    const timer = Timer.getFromRequest(req);
    const ctx = {
      timer,
      authenticationContext: await getAuthenticationContext(req)
    };
    const stats = await xTdhStatsService.getIdentityStats(
      req.params.identity,
      ctx
    );
    res.send(stats);
  }
);

export default router;
