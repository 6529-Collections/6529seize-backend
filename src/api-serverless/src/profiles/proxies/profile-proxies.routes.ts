import { Request, Response } from 'express';
import { asyncRouter } from '../../async.router';
import { ApiResponse } from '../../api-response';
import { profileProxyApiService } from '../../proxies/proxy.api.service';
import { profilesService } from '../../../../profiles/profiles.service';
import { NotFoundException } from '../../../../exceptions';
import { ProfileProxy } from '../../generated/models/ProfileProxy';

const router = asyncRouter({ mergeParams: true });

router.get(
  '/',
  async (
    req: Request<{ identity: string }, any, any, any, any>,
    res: Response<ApiResponse<ProfileProxy[]>>
  ) => {
    const targetProfile =
      await profilesService.getProfileAndConsolidationsByIdentity(
        req.params.identity
      );
    if (!targetProfile?.profile) {
      throw new NotFoundException(
        `Profile with id ${req.params.identity} does not exist`
      );
    }

    const result =
      await profileProxyApiService.getProfileReceivedAndGrantedProxies({
        profile_id: targetProfile.profile.external_id
      });
    res.send(result);
  }
);

router.get(
  '/received',
  async (
    req: Request<{ identity: string }, any, any, any, any>,
    res: Response<ApiResponse<ProfileProxy[]>>
  ) => {
    const targetProfile =
      await profilesService.getProfileAndConsolidationsByIdentity(
        req.params.identity
      );
    if (!targetProfile?.profile) {
      throw new NotFoundException(
        `Profile with id ${req.params.identity} does not exist`
      );
    }

    const result =
      await profileProxyApiService.getProfileReceivedProfileProxies({
        target_id: targetProfile.profile.external_id
      });
    res.send(result);
  }
);

router.get(
  '/granted',
  async (
    req: Request<{ identity: string }, any, any, any, any>,
    res: Response<ApiResponse<ProfileProxy[]>>
  ) => {
    const targetProfile =
      await profilesService.getProfileAndConsolidationsByIdentity(
        req.params.identity
      );
    if (!targetProfile?.profile) {
      throw new NotFoundException(
        `Profile with id ${req.params.identity} does not exist`
      );
    }

    const result = await profileProxyApiService.getProfileGrantedProfileProxies(
      {
        created_by: targetProfile.profile.external_id
      }
    );
    res.send(result);
  }
);

export default router;
