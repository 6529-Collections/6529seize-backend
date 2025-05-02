import { Request, Response } from 'express';
import { asyncRouter } from '../../async.router';
import { ApiResponse } from '../../api-response';
import { profileProxyApiService } from '../../proxies/proxy.api.service';
import { ApiProfileProxy } from '../../generated/models/ApiProfileProxy';
import { identityFetcher } from '../../identities/identity.fetcher';
import { Timer } from '../../../../time';

const router = asyncRouter({ mergeParams: true });

router.get(
  '/',
  async (
    req: Request<{ identity: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiProfileProxy[]>>
  ) => {
    const targetProfile =
      await identityFetcher.getProfileIdByIdentityKeyOrThrow(
        { identityKey: req.params.identity },
        { timer: Timer.getFromRequest(req) }
      );

    const result =
      await profileProxyApiService.getProfileReceivedAndGrantedProxies({
        profile_id: targetProfile
      });
    res.send(result);
  }
);

router.get(
  '/received',
  async (
    req: Request<{ identity: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiProfileProxy[]>>
  ) => {
    const targetProfile =
      await identityFetcher.getProfileIdByIdentityKeyOrThrow(
        { identityKey: req.params.identity },
        { timer: Timer.getFromRequest(req) }
      );

    const result =
      await profileProxyApiService.getProfileReceivedProfileProxies({
        target_id: targetProfile
      });
    res.send(result);
  }
);

router.get(
  '/granted',
  async (
    req: Request<{ identity: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiProfileProxy[]>>
  ) => {
    const targetProfile =
      await identityFetcher.getProfileIdByIdentityKeyOrThrow(
        { identityKey: req.params.identity },
        { timer: Timer.getFromRequest(req) }
      );

    const result = await profileProxyApiService.getProfileGrantedProfileProxies(
      {
        created_by: targetProfile
      }
    );
    res.send(result);
  }
);

export default router;
