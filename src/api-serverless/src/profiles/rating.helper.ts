import { Request } from 'express';
import { getAuthenticationContext } from '../auth/auth';
import { profilesService } from '../../../profiles/profiles.service';
import { NotFoundException } from '../../../exceptions';
import { WALLET_REGEX } from '../../../constants';
import { ProfileClassification } from '../../../entities/IProfile';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { Time } from '../../../time';

export async function getRaterInfoFromRequest(
  req: Request<{ identity: string }, any, any, any, any>
) {
  const identity = req.params.identity.toLowerCase();
  const authContext = await getAuthenticationContext(req);
  let targetProfile =
    await profilesService.getProfileAndConsolidationsByIdentity(identity);
  if (!targetProfile?.profile) {
    const wallet = identity.toLowerCase();
    if (!WALLET_REGEX.test(wallet)) {
      throw new NotFoundException(`No profile found for ${identity}`);
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
      `No profile found for authenticated user ${identity}`
    );
  }
  const targetProfileId = targetProfile.profile!.external_id;
  return { authContext, targetProfileId: targetProfileId };
}

export type RateProfileRequest<REQ_BODY> = Request<
  {
    identity: string;
  },
  any,
  REQ_BODY,
  any,
  any
>;

export type GetRaterAggregatedRatingRequest = Request<
  {
    identity: string;
    raterIdentity: string;
  },
  any,
  any,
  any,
  any
>;
