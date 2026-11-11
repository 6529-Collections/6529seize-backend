import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiDeviceGrant } from '@/api/generated/models/ApiDeviceGrant';
import { ApiDeviceSecurityNotice } from '@/api/generated/models/ApiDeviceSecurityNotice';
import { ApiDropSignedEvents } from '@/api/generated/models/ApiDropSignedEvents';
import { ApiDropSignedEventsBatch } from '@/api/generated/models/ApiDropSignedEventsBatch';
import { ApiRegisterDeviceGrantRequest } from '@/api/generated/models/ApiRegisterDeviceGrantRequest';
import {
  AcknowledgeDeviceGrantRequest,
  GetDeviceGrantsRequest,
  GetDeviceSecurityNoticesRequest,
  GetDropSignedEventsRequest,
  GetDropsSignedEventsRequest,
  RegisterDeviceGrantRequest,
  RenameDeviceGrantRequest,
  RevokeDeviceGrantRequest
} from '@/api/generated/routes/operations';
import { revokeE2eeDeviceOfLoginGrant } from '@/api/e2ee/e2ee.handlers';
import { Logger } from '@/logging';
import { Timer } from '@/time';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { deviceGrantsService } from './device-grants.service';
import {
  deviceLabelRenameSchema,
  parseDropSignedEventsBatchIds,
  registerDeviceGrantSchema
} from './device-signing.validation';
import {
  DROP_SIGNED_EVENTS_BATCH_MAX_DROPS,
  dropSignedEventsService
} from './drop-signed-events.service';
import { grantRegistrationRequestOf } from './grant-origins';

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

export async function handleGetDeviceSecurityNotices(
  req: GetDeviceSecurityNoticesRequest
): Promise<ApiDeviceSecurityNotice[]> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return deviceGrantsService.listCallerSecurityNotices({
    timer,
    authenticationContext
  });
}

export async function handleRegisterDeviceGrant(
  req: RegisterDeviceGrantRequest
): Promise<ApiDeviceGrant> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return deviceGrantsService.registerAppGrant(
    getValidatedByJoiOrThrow(
      req.body as ApiRegisterDeviceGrantRequest,
      registerDeviceGrantSchema
    ),
    {
      timer,
      authenticationContext,
      registration: grantRegistrationRequestOf(
        req,
        authenticationContext.accessTokenSession
      )
    }
  );
}

export async function handleRenameDeviceGrant(
  req: RenameDeviceGrantRequest
): Promise<ApiDeviceGrant> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  const { label } = getValidatedByJoiOrThrow(
    req.body as { label: string },
    deviceLabelRenameSchema
  );
  return deviceGrantsService.renameCallerGrant(req.params.grantId, label, {
    timer,
    authenticationContext
  });
}

export async function handleAcknowledgeDeviceGrant(
  req: AcknowledgeDeviceGrantRequest
): Promise<ApiDeviceGrant> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return deviceGrantsService.acknowledgeCallerGrant(req.params.grantId, {
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

export async function handleGetDropsSignedEvents(
  req: GetDropsSignedEventsRequest
): Promise<ApiDropSignedEventsBatch> {
  const dropIds = parseDropSignedEventsBatchIds(
    req.query.drop_ids,
    DROP_SIGNED_EVENTS_BATCH_MAX_DROPS
  );
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return dropSignedEventsService.findForDrops(dropIds, {
    timer,
    authenticationContext
  });
}
