import { getAuthenticationContext } from '@/api/auth/auth';
import { identitiesDb } from '@/identities/identities.db';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import * as Joi from 'joi';
import type * as Operations from '@/api/generated/routes/operations';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import { artistArtworkAlertsDb } from '@/notifications/artist-artwork-alerts.db';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { Timer } from '@/time';

type AlertRequest =
  | Operations.GetArtistArtworkAlertRequest
  | Operations.EnableArtistArtworkAlertRequest
  | Operations.DisableArtistArtworkAlertRequest;

const identitySchema = Joi.object<{ id: string }>({
  id: Joi.string().required()
});

async function resolvePair(req: AlertRequest) {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const subscriberId = authenticationContext.getActingAsId();
  if (!subscriberId || authenticationContext.isAuthenticatedAsProxy()) {
    throw new ForbiddenException(
      'Sign in with your own profile to manage artwork alerts'
    );
  }
  const { id } = getValidatedByJoiOrThrow(req.params, identitySchema);
  const ctx = { authenticationContext, timer };
  const artistId = await identitiesDb.getProfileIdByIdentityKeyFast(
    { identityKey: id },
    ctx
  );
  if (!artistId)
    throw new NotFoundException(`Profile not found for identity ${id}`);
  if (subscriberId === artistId) {
    throw new BadRequestException(
      'You cannot enable artwork alerts for your own profile'
    );
  }
  return { pair: { subscriberId, artistId }, ctx };
}

export async function handleGetArtistArtworkAlert(
  req: Operations.GetArtistArtworkAlertRequest
): Promise<Operations.GetArtistArtworkAlertResponse> {
  const { pair, ctx } = await resolvePair(req);
  return {
    enabled: await artistArtworkAlertsDb.isEnabled(pair, ctx)
  };
}

export async function handleEnableArtistArtworkAlert(
  req: Operations.EnableArtistArtworkAlertRequest
): Promise<Operations.EnableArtistArtworkAlertResponse> {
  const { pair, ctx } = await resolvePair(req);
  if (
    await contentModerationDb.isProfileBlocked(pair.subscriberId, pair.artistId)
  ) {
    throw new ForbiddenException(
      'Unblock this profile before enabling artwork alerts'
    );
  }
  await artistArtworkAlertsDb.setEnabled(pair, true, ctx);
  return { enabled: true };
}

export async function handleDisableArtistArtworkAlert(
  req: Operations.DisableArtistArtworkAlertRequest
): Promise<Operations.DisableArtistArtworkAlertResponse> {
  const { pair, ctx } = await resolvePair(req);
  await artistArtworkAlertsDb.setEnabled(pair, false, ctx);
  return { enabled: false };
}
