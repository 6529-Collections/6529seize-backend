import { Request } from 'express';
import { getAuthenticationContext } from '../auth/auth';
import { profilesService } from '../../../profiles/profiles.service';
import { NotFoundException } from '../../../exceptions';
import { ProfileClassification } from '../../../entities/IProfile';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { Time, Timer } from '../../../time';
import { identityFetcher } from '../identities/identity.fetcher';
import { getWalletFromEns } from '../../../alchemy';
import { ethTools } from '../../../eth-tools';

export async function getRaterInfoFromRequest(
  req: Request<{ identity: string }, any, any, any, any>
) {
  const identity = req.params.identity.toLowerCase();
  const authContext = await getAuthenticationContext(req);
  const timer = Timer.getFromRequest(req);
  let targetProfile =
    await identityFetcher.getIdentityAndConsolidationsByIdentityKey(
      { identityKey: identity },
      { authenticationContext: authContext, timer }
    );
  if (!targetProfile?.id) {
    let wallet = identity.toLowerCase();
    if (!ethTools.isEthAddress(wallet)) {
      wallet = await getWalletFromEns(identity).then((w) => {
        if (!w) {
          throw new NotFoundException(`No profile found for ${identity}`);
        }
        return w;
      });
    }
    timer.start(`profilesService->createOrUpdateProfile(${wallet})`);
    targetProfile = await profilesService.createOrUpdateProfile({
      handle: `id-${wallet}`,
      creator_or_updater_wallet: wallet,
      classification: ProfileClassification.PSEUDONYM,
      sub_classification: null,
      pfp_url: null
    });
    timer.stop(`profilesService->createOrUpdateProfile(${wallet})`);
    timer.start(`artificial2SecondLag`);
    await giveReadReplicaTimeToCatchUp(Time.seconds(2).toMillis());
    timer.stop(`artificial2SecondLag`);
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
