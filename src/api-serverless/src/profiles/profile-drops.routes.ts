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
      { limit: number; id_less_than?: number },
      any
    >,
    res: Response<ApiResponse<DropFull[]>>
  ) => {
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
      profile_id: profileId
    });
    res.send(profileDrops);
  }
);

export default router;
