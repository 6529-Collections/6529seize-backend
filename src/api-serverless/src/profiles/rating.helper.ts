import { Request } from 'express';
import { getWalletOrThrow } from '../auth/auth';
import { profilesService } from '../../../profiles/profiles.service';
import { NotFoundException } from '../../../exceptions';

export async function getRaterInfoFromRequest(
  req: Request<{ handleOrWallet: string }, any, any, any, any>
) {
  const handleOrWallet = req.params.handleOrWallet.toLowerCase();
  const raterWallet = getWalletOrThrow(req);
  const targetProfile =
    await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
      handleOrWallet
    );
  if (!targetProfile?.profile) {
    throw new NotFoundException(`No profile found for ${handleOrWallet}`);
  }
  const raterProfile =
    await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
      raterWallet
    );
  if (!raterProfile?.profile) {
    throw new NotFoundException(
      `No profile found for authenticated used ${handleOrWallet}`
    );
  }
  const raterProfileId = raterProfile.profile.external_id;
  const targetProfileId = targetProfile.profile.external_id;
  return { handleOrWallet, raterProfileId, targetProfileId };
}

export type GetProfileRatingsRequest = Request<
  {
    handleOrWallet: string;
  },
  any,
  any,
  {
    order: string;
    order_by: string;
    page?: string;
    page_size?: string;
    rater?: string | null;
  },
  any
>;

export type RateProfileRequest<REQ_BODY> = Request<
  {
    handleOrWallet: string;
  },
  any,
  REQ_BODY,
  any,
  any
>;

export async function getRatingsSearchParamsFromRequest(
  req: Request<
    { handleOrWallet: string },
    any,
    any,
    {
      order: string;
      order_by: string;
      page?: string;
      page_size?: string;
      rater?: string | null;
    },
    any
  >
) {
  const order = req.query.order?.toLowerCase();
  const order_by = req.query.order_by?.toLowerCase();
  const page = req.query.page ? parseInt(req.query.page) : 1;
  const page_size = req.query.page_size ? parseInt(req.query.page_size) : 200;
  const targetHandleOrWallet = req.params.handleOrWallet.toLowerCase();
  const profileAndConsolidationsOfTarget =
    await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
      targetHandleOrWallet
    );
  const targetProfile = profileAndConsolidationsOfTarget?.profile;
  if (!targetProfile) {
    throw new NotFoundException(`No profile found for ${targetHandleOrWallet}`);
  }
  let rater_profile_id: string | null = null;
  if (req.query.rater) {
    rater_profile_id =
      (
        await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
          req.query.rater
        )
      )?.profile?.external_id ?? null;
  }
  return { order, order_by, page, page_size, targetProfile, rater_profile_id };
}
