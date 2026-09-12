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
import { AuthenticationContext } from '../../../auth-context';

export async function getRaterInfoFromRequest(
  req: Request<{ identity: string }, any, any, any, any>
) {
  const authContext = await getRaterAuthenticationContext(req);
  const timer = Timer.getFromRequest(req);
  const targetProfileId = await getRatingTargetProfileId(
    req.params.identity,
    authContext,
    timer
  );
  return { authContext, targetProfileId };
}

export async function getRaterAuthenticationContext(
  req: Request<{ identity: string }, any, any, any, any>
) {
  const authContext = await getAuthenticationContext(req);
  if (!authContext.authenticatedProfileId) {
    throw new NotFoundException(
      `No profile found for authenticated user ${req.params.identity.toLowerCase()}`
    );
  }
  return authContext;
}

export async function getRatingTargetProfileId(
  targetIdentity: string,
  authContext: AuthenticationContext,
  timer: Timer
): Promise<string> {
  const identity = targetIdentity.toLowerCase();
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
  return targetProfile.id!;
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
