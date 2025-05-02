import { Request } from 'express';
import { getAuthenticationContext } from '../auth/auth';
import { profilesService } from '../../../profiles/profiles.service';
import { NotFoundException } from '../../../exceptions';
import { ProfileClassification } from '../../../entities/IProfile';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { Time } from '../../../time';
import { getWalletFromEns, isWallet } from '../../../helpers';
import { identityFetcher } from '../identities/identity.fetcher';

export async function getRaterInfoFromRequest(
  req: Request<{ identity: string }, any, any, any, any>
) {
  const identity = req.params.identity.toLowerCase();
  const authContext = await getAuthenticationContext(req);
  let targetProfile =
    await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
      { identityKey: identity },
      { authenticationContext: authContext }
    );
  if (!targetProfile?.id) {
    let wallet = identity.toLowerCase();
    if (!isWallet(wallet)) {
      wallet = await getWalletFromEns(identity).then((w) => {
        if (!w) {
          throw new NotFoundException(`No profile found for ${identity}`);
        }
        return w;
      });
    }
    targetProfile = await profilesService.createOrUpdateProfile({
      handle: `id-${wallet}`,
      creator_or_updater_wallet: wallet,
      classification: ProfileClassification.PSEUDONYM,
      sub_classification: null,
      pfp_url: null
    });
    await giveReadReplicaTimeToCatchUp(Time.seconds(2).toMillis());
  }
  if (!authContext.authenticatedProfileId) {
    throw new NotFoundException(
      `No profile found for authenticated user ${identity}`
    );
  }
  const targetProfileId = targetProfile.id!;
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
