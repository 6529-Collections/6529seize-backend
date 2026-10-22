import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiDeviceGrant } from '@/api/generated/models/ApiDeviceGrant';
import { ApiDropSignedEvents } from '@/api/generated/models/ApiDropSignedEvents';
import {
  GetDeviceGrantsRequest,
  GetDropSignedEventsRequest,
  RevokeDeviceGrantRequest
} from '@/api/generated/routes/operations';
import { Timer } from '@/time';
import { deviceGrantsService } from './device-grants.service';
import { dropSignedEventsService } from './drop-signed-events.service';

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
  return deviceGrantsService.revokeCallerGrant(req.params.grantId, {
    timer,
    authenticationContext
  });
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
