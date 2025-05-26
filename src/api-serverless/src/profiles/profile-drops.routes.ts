import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { dropsService } from '../drops/drops.api.service';
import { asyncRouter } from '../async.router';
import { identityFetcher } from '../identities/identity.fetcher';
import { Timer } from '../../../time';

const router = asyncRouter({ mergeParams: true });

router.get(
  '/available-credit-for-rating',
  async (
    req: Request<{ identity: string }, any, any, any, any>,
    res: Response<ApiResponse<{ available_credit_for_rating: number }>>
  ) => {
    const identity = req.params.identity;
    const profileId = await identityFetcher.getProfileIdByIdentityKeyOrThrow(
      { identityKey: identity },
      { timer: Timer.getFromRequest(req) }
    );
    const rep =
      await dropsService.findAvailableCreditForRatingForProfile(profileId);
    res.send(rep);
  }
);

export default router;
