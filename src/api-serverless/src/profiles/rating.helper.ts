import { Request } from 'express';
import { getWalletOrThrow } from '../auth/auth';
import { profilesService } from '../../../profiles/profiles.service';
import { NotFoundException } from '../../../exceptions';
import { RateMatter } from '../../../entities/IRating';

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
      `No profile found for authenticated user ${handleOrWallet}`
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
    given?: string;
    page?: string;
    page_size?: string;
    order?: string;
    order_by?: string;
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

export type GetRatingsByRatersForMatterParams = {
  given: boolean;
  profileId: string;
  page: number;
  matter: RateMatter;
  page_size: number;
  order: string;
  order_by: string;
};

export async function getRatingsSearchParamsFromRequest({
  queryParams,
  handleOrWallet,
  matter
}: {
  queryParams: GetProfileRatingsRequest['query'];
  handleOrWallet: string;
  matter: RateMatter;
}): Promise<GetRatingsByRatersForMatterParams> {
  const given = queryParams.given === 'true';
  const page = queryParams.page ? parseInt(queryParams.page) : 1;
  const page_size = queryParams.page_size
    ? parseInt(queryParams.page_size)
    : 200;
  const order = queryParams.order?.toLowerCase() === 'asc' ? 'asc' : 'desc';
  const order_by =
    queryParams.order_by?.toLowerCase() === 'rating'
      ? 'rating'
      : 'last_modified';
  const profile =
    await profilesService.getProfileAndConsolidationsByHandleOrEnsOrWalletAddress(
      handleOrWallet.toLocaleLowerCase()
    );
  const profile_id = profile?.profile?.external_id;
  if (!profile_id) {
    throw new NotFoundException(`No profile found for ${handleOrWallet}`);
  }
  return {
    profileId: profile_id,
    matter,
    given,
    page,
    page_size,
    order,
    order_by
  };
}
