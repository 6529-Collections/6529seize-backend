import { Request } from 'express';
import { getAuthenticationContext } from '../auth/auth';
import { profilesService } from '../../../profiles/profiles.service';
import { NotFoundException } from '../../../exceptions';

export async function getRaterInfoFromRequest(
  req: Request<{ handleOrWallet: string }, any, any, any, any>
) {
  const handleOrWallet = req.params.handleOrWallet.toLowerCase();
  const authContext = await getAuthenticationContext(req);
  const targetProfile =
    await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
      handleOrWallet
    );
  if (!targetProfile?.profile) {
    throw new NotFoundException(`No profile found for ${handleOrWallet}`);
  }
  if (!authContext.authenticatedProfileId) {
    throw new NotFoundException(
      `No profile found for authenticated user ${handleOrWallet}`
    );
  }
  const targetProfileId = targetProfile.profile!.external_id;
  return { authContext, targetProfileId: targetProfileId };
}

export type RateProfileRequest<REQ_BODY> = Request<
  {
    handleOrWallet: string;
  },
  any,
  REQ_BODY,
  any,
  any
>;

export type GetRaterAggregatedRatingRequest = Request<
  {
    handleOrWallet: string;
    raterHandleOrWallet: string;
  },
  any,
  any,
  any,
  any
>;
