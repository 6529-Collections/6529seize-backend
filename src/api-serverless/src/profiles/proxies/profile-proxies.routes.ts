import { Request, Response } from 'express';
import { asyncRouter } from '../../async.router';
import { ApiResponse } from '../../api-response';
import { profileProxyApiService } from '../../proxies/proxy.api.service';
import { profilesService } from '../../../../profiles/profiles.service';
import { NotFoundException } from '../../../../exceptions';
import { ProfileProxy } from '../../generated/models/ProfileProxy';

const router = asyncRouter({ mergeParams: true });

router.get(
  '/received',
  async (
    req: Request<
      { handleOrWallet: string },
      any,
      any,
      { only_active?: string },
      any
    >,
    res: Response<ApiResponse<ProfileProxy[]>>
  ) => {
    const targetProfile =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        req.params.handleOrWallet
      );
    if (!targetProfile?.profile) {
      throw new NotFoundException(
        `Profile with id ${req.params.handleOrWallet} does not exist`
      );
    }

    const get_only_active_actions = req.query.only_active === 'true';

    const result =
      await profileProxyApiService.getProfileReceivedProfileProxies({
        target_id: targetProfile.profile.external_id,
        get_only_active_actions
      });
    res.send(result);
  }
);

router.get(
  '/granted',
  async (
    req: Request<
      { handleOrWallet: string },
      any,
      any,
      { only_active?: string },
      any
    >,
    res: Response<ApiResponse<ProfileProxy[]>>
  ) => {
    const targetProfile =
      await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        req.params.handleOrWallet
      );
    if (!targetProfile?.profile) {
      throw new NotFoundException(
        `Profile with id ${req.params.handleOrWallet} does not exist`
      );
    }

    const get_only_active_actions = req.query.only_active === 'true';
    const result = await profileProxyApiService.getProfileGrantedProfileProxies(
      {
        created_by: targetProfile.profile.external_id,
        get_only_active_actions
      }
    );
    res.send(result);
  }
);

export default router;
