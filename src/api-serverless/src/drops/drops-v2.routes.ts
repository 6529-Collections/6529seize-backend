import { asyncRouter } from '@/api/async.router';
import { Request, Response } from 'express';
import {
  getAuthenticationContext,
  maybeAuthenticatedUser
} from '@/api/auth/auth';
import { ApiResponse } from '@/api/api-response';
import { Timer } from '@/time';
import { ApiDropAndWave } from '@/api/generated/models/ApiDropAndWave';
import { apiDropV2Service } from '@/api/drops/api-drop-v2.service';

const router = asyncRouter();

router.get(
  '/:drop_id',
  maybeAuthenticatedUser(),
  async (
    req: Request<{ drop_id: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiDropAndWave>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const dropId = req.params.drop_id;
    const drop = await apiDropV2Service.findWithWaveByIdOrThrow(dropId, {
      timer,
      authenticationContext
    });
    res.send(drop);
  }
);

export default router;
