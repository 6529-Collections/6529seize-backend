import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { parseNumberOrNull } from '../../../helpers';
import { profilesService } from '../../../profiles/profiles.service';
import { dropsService } from '../drops/drops.api.service';
import { asyncRouter } from '../async.router';
import { NotFoundException } from '../../../exceptions';
import { Drop } from '../generated/models/Drop';
import { getAuthenticationContext, needsAuthenticatedUser } from '../auth/auth';

const router = asyncRouter({ mergeParams: true });

router.get(
  '/',
  needsAuthenticatedUser(),
  async (
    req: Request<
      { handleOrWallet: string },
      any,
      any,
      { limit: number; serial_no_less_than?: number },
      any
    >,
    res: Response<ApiResponse<Drop[]>>
  ) => {
    const authenticationContext = await getAuthenticationContext(req);
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
      serial_no_less_than: parseNumberOrNull(req.query.serial_no_less_than),
      profile_id: profileId,
      authenticationContext
    });
    res.send(profileDrops);
  }
);

router.get(
  '/available-credit-for-rating',
  async (
    req: Request<{ handleOrWallet: string }, any, any, any, any>,
    res: Response<ApiResponse<{ available_credit_for_rating: number }>>
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
    const rep = await dropsService.findAvailableCreditForRatingForProfile(
      profileId
    );
    res.send(rep);
  }
);

export default router;
