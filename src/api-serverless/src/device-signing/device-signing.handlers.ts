import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiDeviceGrant } from '@/api/generated/models/ApiDeviceGrant';
import { ApiDropSignedEvents } from '@/api/generated/models/ApiDropSignedEvents';
import {
  GetDeviceGrantsRequest,
  GetDropSignedEventsRequest,
  RevokeDeviceGrantRequest
} from '@/api/generated/routes/operations';
import { revokeE2eeDeviceOfLoginGrant } from '@/api/e2ee/e2ee.handlers';
import { Logger } from '@/logging';
import { Timer } from '@/time';
import { deviceGrantsService } from './device-grants.service';
import { dropSignedEventsService } from './drop-signed-events.service';

const logger = Logger.get('DEVICE_SIGNING_HANDLERS');

export async function handleGetDeviceGrants(
  req: GetDeviceGrantsRequest
): Promise<ApiDeviceGrant[]> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return deviceGrantsService.listCallerGrants({
    timer,
    authenticationContext
  });
}

export async function handleRevokeDeviceGrant(
  req: RevokeDeviceGrantRequest
): Promise<ApiDeviceGrant> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const revoked = await deviceGrantsService.revokeCallerGrant(
    req.params.grantId,
    { timer, authenticationContext }
  );
  // A combined sign-in grant also enrolled an encrypted-messages device:
  // revoking the grant revokes that device too.
  try {
    await revokeE2eeDeviceOfLoginGrant(revoked.id);
  } catch (error) {
    logger.error(
      `Failed to revoke the E2EE device of sign-in grant ${revoked.id}`,
      error
    );
  }
  return revoked;
}

export async function handleGetDropSignedEvents(
  req: GetDropSignedEventsRequest
): Promise<ApiDropSignedEvents> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return dropSignedEventsService.findForDrop(req.params.dropId, {
    timer,
    authenticationContext
  });
}
