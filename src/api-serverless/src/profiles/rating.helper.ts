import { Request } from 'express';
import { getAuthenticationContext } from '../auth/auth';
import { profilesService } from '../../../profiles/profiles.service';
import { NotFoundException } from '../../../exceptions';
import { WALLET_REGEX } from '../../../constants';
import { ProfileClassification } from '../../../entities/IProfile';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { Time } from '../../../time';

export async function getRaterInfoFromRequest(
  req: Request<{ handleOrWallet: string }, any, any, any, any>
) {
  const handleOrWallet = req.params.handleOrWallet.toLowerCase();
  const authContext = await getAuthenticationContext(req);
  let targetProfile =
    await profilesService.getProfileAndConsolidationsByHandleOrEnsOrIdOrWalletAddress(
      handleOrWallet
    );
  if (!targetProfile?.profile) {
    const wallet = handleOrWallet.toLowerCase();
    if (!WALLET_REGEX.test(wallet)) {
      throw new NotFoundException(`No profile found for ${handleOrWallet}`);
    }
    targetProfile = await profilesService.createOrUpdateProfile({
      handle: `id-${wallet}`,
      creator_or_updater_wallet: wallet,
      classification: ProfileClassification.PSEUDONYM,
      sub_classification: null
    });
    await giveReadReplicaTimeToCatchUp(Time.seconds(2).toMillis());
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
