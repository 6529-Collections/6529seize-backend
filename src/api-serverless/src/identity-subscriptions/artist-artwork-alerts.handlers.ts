import { getAuthenticationContext } from '@/api/auth/auth';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import type * as Operations from '@/api/generated/routes/operations';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { artistArtworkAlertsDb } from '@/notifications/artist-artwork-alerts.db';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { Timer } from '@/time';

type AlertRequest =
  | Operations.GetArtistArtworkAlertRequest
  | Operations.EnableArtistArtworkAlertRequest
  | Operations.DisableArtistArtworkAlertRequest;

async function resolvePair(req: AlertRequest) {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const subscriberId = authenticationContext.getActingAsId();
  if (!subscriberId || authenticationContext.isAuthenticatedAsProxy()) {
    throw new ForbiddenException(
      'Sign in with your own profile to manage artwork alerts'
    );
  }
  const artistId = await identityFetcher.getProfileIdByIdentityKeyOrThrow(
    { identityKey: req.params.id },
    { authenticationContext, timer }
  );
  if (subscriberId === artistId) {
    throw new BadRequestException(
      'You cannot enable artwork alerts for your own profile'
    );
  }
  return { subscriberId, artistId };
}

export async function handleGetArtistArtworkAlert(
  req: Operations.GetArtistArtworkAlertRequest
): Promise<Operations.GetArtistArtworkAlertResponse> {
  return {
    enabled: await artistArtworkAlertsDb.isEnabled(await resolvePair(req))
  };
}

export async function handleEnableArtistArtworkAlert(
  req: Operations.EnableArtistArtworkAlertRequest
): Promise<Operations.EnableArtistArtworkAlertResponse> {
  const pair = await resolvePair(req);
  if (
    await contentModerationDb.isProfileBlocked(pair.subscriberId, pair.artistId)
  ) {
    throw new ForbiddenException(
      'Unblock this profile before enabling artwork alerts'
    );
  }
  await artistArtworkAlertsDb.setEnabled(pair, true);
  return { enabled: true };
}

export async function handleDisableArtistArtworkAlert(
  req: Operations.DisableArtistArtworkAlertRequest
): Promise<Operations.DisableArtistArtworkAlertResponse> {
  await artistArtworkAlertsDb.setEnabled(await resolvePair(req), false);
  return { enabled: false };
}
