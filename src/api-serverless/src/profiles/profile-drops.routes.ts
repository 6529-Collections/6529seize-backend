import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { profilesService } from '../../../profiles/profiles.service';
import { dropsService } from '../drops/drops.api.service';
import { asyncRouter } from '../async.router';
import { NotFoundException } from '../../../exceptions';

const router = asyncRouter({ mergeParams: true });

router.get(
  '/available-credit-for-rating',
  async (
    req: Request<{ identity: string }, any, any, any, any>,
    res: Response<ApiResponse<{ available_credit_for_rating: number }>>
  ) => {
    const identity = req.params.identity;
    const profileId = await profilesService
      .getProfileAndConsolidationsByIdentity(identity)
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
