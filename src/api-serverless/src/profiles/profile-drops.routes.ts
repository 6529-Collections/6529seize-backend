import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { DropFull } from '../../../drops/drops.types';
import { parseNumberOrNull } from '../../../helpers';
import { profilesService } from '../../../profiles/profiles.service';
import { dropsService } from '../../../drops/drops.service';
import { asyncRouter } from '../async.router';
import { NotFoundException } from '../../../exceptions';

const router = asyncRouter({ mergeParams: true });

router.get(
  '/',
  async (
    req: Request<
      { handleOrWallet: string },
      any,
      any,
      { limit: number; id_less_than?: number; input_profile?: string },
      any
    >,
    res: Response<ApiResponse<DropFull[]>>
  ) => {
    const inputProfileId = req.query.input_profile
      ? await profilesService
          .getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
            req.query.input_profile
          )
          ?.then((result) => result?.profile?.external_id)
      : undefined;
    const limit = parseNumberOrNull(req.query.limit) ?? 10;
    const handleOrWallet = req.params.handleOrWallet;
    const profileId = await profilesService
      .getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        handleOrWallet
      )
      .then((result) => result?.profile?.external_id ?? null);
    if (!profileId) {
      throw new NotFoundException('Profile not found');
    }
    const profileDrops = await dropsService.findProfilesLatestDrops({
      amount: limit < 0 || limit > 200 ? 10 : limit,
      id_less_than: parseNumberOrNull(req.query.id_less_than),
      profile_id: profileId,
      inputProfileId
    });
    res.send(profileDrops);
  }
);

router.get(
  '/available-tdh-for-rep',
  async (
    req: Request<{ handleOrWallet: string }, any, any, any, any>,
    res: Response<ApiResponse<{ available_tdh_for_rep: number }>>
  ) => {
    const handleOrWallet = req.params.handleOrWallet;
    const profileId = await profilesService
      .getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
        handleOrWallet
      )
      .then((result) => result?.profile?.external_id ?? null);
    if (!profileId) {
      throw new NotFoundException('Profile not found');
    }
    const rep = await dropsService.findAvailableTdhForRepForProfile(profileId);
    res.send(rep);
  }
);

export default router;
