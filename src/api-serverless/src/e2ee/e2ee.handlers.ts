import { getAuthenticationContext } from '@/api/auth/auth';
import {
  E2eeBackupServiceDeps,
  E2eeBackupsService
} from '@/api/e2ee/e2ee-backups.service';
import { E2eeBlobsService } from '@/api/e2ee/e2ee-blobs.service';
import {
  defaultE2eeServiceDeps,
  E2eeServiceDeps
} from '@/api/e2ee/e2ee-context';
import { E2eeDevicesService } from '@/api/e2ee/e2ee-devices.service';
import { E2eeGroupsService } from '@/api/e2ee/e2ee-groups.service';
import {
  e2eeBackupChunkListQuerySchema,
  e2eeBackupChunkUploadSchema,
  e2eeBackupDeviceSchema,
  e2eeBackupIdParamSchema,
  e2eeBackupSeqParamSchema,
  e2eeBlobChunkSchema,
  e2eeBlobIdParamSchema,
  e2eeChunkIndexParamSchema,
  e2eeClaimKeyPackagesSchema,
  e2eeCompactBackupSchema,
  e2eeCreateBackupSchema,
  e2eeCreateBlobSchema,
  e2eeCreateGroupSchema,
  e2eeDeviceKeyParamSchema,
  e2eeDeviceLookupSchema,
  e2eeDeviceQuerySchema,
  e2eeEligibilitySchema,
  e2eeGroupParamSchema,
  e2eeLogQuerySchema,
  e2eeProfileIdParamSchema,
  e2eeRegisterDeviceSchema,
  e2eeReportSchema,
  e2eeRevokeDeviceSchema,
  e2eeRosterRepairSchema,
  e2eeSendMessageSchema,
  e2eeSubmitEntrySchema,
  e2eeUploadKeyPackagesSchema,
  validateE2ee
} from '@/api/e2ee/e2ee.validation';
import { ApiE2eeAck } from '@/api/generated/models/ApiE2eeAck';
import { ApiE2eeBackup } from '@/api/generated/models/ApiE2eeBackup';
import { ApiE2eeBackupChunk } from '@/api/generated/models/ApiE2eeBackupChunk';
import { ApiE2eeBackupChunkData } from '@/api/generated/models/ApiE2eeBackupChunkData';
import { ApiE2eeBackupChunkPage } from '@/api/generated/models/ApiE2eeBackupChunkPage';
import { ApiE2eeBackupChunkUpload } from '@/api/generated/models/ApiE2eeBackupChunkUpload';
import { ApiE2eeBackupStatus } from '@/api/generated/models/ApiE2eeBackupStatus';
import { ApiE2eeBlob } from '@/api/generated/models/ApiE2eeBlob';
import { ApiE2eeBlobChunk } from '@/api/generated/models/ApiE2eeBlobChunk';
import { ApiE2eeClaimKeyPackagesRequest } from '@/api/generated/models/ApiE2eeClaimKeyPackagesRequest';
import { ApiE2eeClaimKeyPackagesResponse } from '@/api/generated/models/ApiE2eeClaimKeyPackagesResponse';
import { ApiE2eeCompactBackupRequest } from '@/api/generated/models/ApiE2eeCompactBackupRequest';
import { ApiE2eeCreateBackupRequest } from '@/api/generated/models/ApiE2eeCreateBackupRequest';
import { ApiE2eeCreateBlobRequest } from '@/api/generated/models/ApiE2eeCreateBlobRequest';
import { ApiE2eeCreateGroupRequest } from '@/api/generated/models/ApiE2eeCreateGroupRequest';
import { ApiE2eeDevice } from '@/api/generated/models/ApiE2eeDevice';
import { ApiE2eeDeviceLookupRequest } from '@/api/generated/models/ApiE2eeDeviceLookupRequest';
import { ApiE2eeDeviceLookupResponse } from '@/api/generated/models/ApiE2eeDeviceLookupResponse';
import { ApiE2eeDeviceGroup } from '@/api/generated/models/ApiE2eeDeviceGroup';
import { ApiE2eeEligibilityRequest } from '@/api/generated/models/ApiE2eeEligibilityRequest';
import { ApiE2eeEligibilityResponse } from '@/api/generated/models/ApiE2eeEligibilityResponse';
import { ApiE2eeGroup } from '@/api/generated/models/ApiE2eeGroup';
import { ApiE2eeKeyPackageStatus } from '@/api/generated/models/ApiE2eeKeyPackageStatus';
import { ApiE2eeLogItem } from '@/api/generated/models/ApiE2eeLogItem';
import { ApiE2eeLogPage } from '@/api/generated/models/ApiE2eeLogPage';
import { ApiE2eeMe } from '@/api/generated/models/ApiE2eeMe';
import { ApiE2eeRegisterDeviceRequest } from '@/api/generated/models/ApiE2eeRegisterDeviceRequest';
import { ApiE2eeReport } from '@/api/generated/models/ApiE2eeReport';
import { ApiE2eeReportRequest } from '@/api/generated/models/ApiE2eeReportRequest';
import { ApiE2eeRevokeDeviceRequest } from '@/api/generated/models/ApiE2eeRevokeDeviceRequest';
import { ApiE2eeRosterRepairRequest } from '@/api/generated/models/ApiE2eeRosterRepairRequest';
import { ApiE2eeSendMessageRequest } from '@/api/generated/models/ApiE2eeSendMessageRequest';
import { ApiE2eeSendMessageResponse } from '@/api/generated/models/ApiE2eeSendMessageResponse';
import { ApiE2eeSubmitEntryRequest } from '@/api/generated/models/ApiE2eeSubmitEntryRequest';
import { ApiE2eeUploadKeyPackagesRequest } from '@/api/generated/models/ApiE2eeUploadKeyPackagesRequest';
import { ApiE2eeWelcome } from '@/api/generated/models/ApiE2eeWelcome';
import {
  E2eeAckWelcomeRequest,
  E2eeActivateBackupRequest,
  E2eeAppendBackupChunkRequest,
  E2eeCheckEligibilityRequest,
  E2eeClaimKeyPackagesRequest,
  E2eeCompactBackupRequest,
  E2eeCompleteBlobRequest,
  E2eeCreateBackupRequest,
  E2eeCreateBlobRequest,
  E2eeDeleteBackupsRequest,
  E2eeGetBackupChunkRequest,
  E2eeGetBackupRequest,
  E2eeGetBackupStatusRequest,
  E2eeCreateGroupRequest,
  E2eeGetBlobChunkRequest,
  E2eeGetDeviceGroupsRequest,
  E2eeGetDeviceRequest,
  E2eeGetGroupLogRequest,
  E2eeGetGroupRequest,
  E2eeGetMeRequest,
  E2eeGetProfileDevicesRequest,
  E2eeGetWelcomesRequest,
  E2eeListBackupChunksRequest,
  E2eeLookupDevicesRequest,
  E2eePutBlobChunkRequest,
  E2eeRegisterDeviceRequest,
  E2eeRepairRosterRequest,
  E2eeReportMessageRequest,
  E2eeRevokeDeviceRequest,
  E2eeSendMessageRequest,
  E2eeSubmitEntryRequest,
  E2eeUploadKeyPackagesRequest
} from '@/api/generated/routes/operations';
import { e2eeBackupDb } from '@/e2ee/e2ee-backup.db';
import { e2eeCiphertextStore } from '@/e2ee/e2ee-ciphertext-store';
import { E2EE_BLOB_ID_PATTERN } from '@/e2ee/e2ee-encoding';
import { e2eeErrors } from '@/e2ee/e2ee-errors';
import { isE2eeBackupsEnabled, isE2eeEnabled } from '@/e2ee/e2ee-flag';
import { Timer } from '@/time';
import { Request } from 'express';
import * as Joi from 'joi';

// Thin handlers for the E2EE delivery service (D109 contract v1, section 4).
// Every route checks the flag first, then requires a non-proxy profile.

export function createE2eeServices(
  deps: E2eeServiceDeps,
  backupDeps: Omit<E2eeBackupServiceDeps, 'e2ee'> = {
    backups: e2eeBackupDb,
    store: e2eeCiphertextStore,
    backupsEnabled: () => isE2eeBackupsEnabled()
  }
) {
  return {
    devices: new E2eeDevicesService(deps),
    groups: new E2eeGroupsService(deps),
    blobs: new E2eeBlobsService(deps),
    backups: new E2eeBackupsService({ ...backupDeps, e2ee: deps })
  };
}

const services = createE2eeServices(defaultE2eeServiceDeps);

async function e2eeCaller(
  req: Request<any, any, any, any, any>
): Promise<string> {
  if (!isE2eeEnabled()) throw e2eeErrors.disabled();
  const context = await getAuthenticationContext(
    req,
    Timer.getFromRequest(req)
  );
  if (context.isAuthenticatedAsProxy()) {
    throw e2eeErrors.forbidden('Proxies cannot use encrypted messaging');
  }
  const profileId = context.getActingAsId();
  if (!profileId) {
    throw e2eeErrors.forbidden('Create a profile to use encrypted messaging');
  }
  return profileId;
}

const deviceKeyOf = (req: { params: { device_key: string } }) =>
  validateE2ee(req.params.device_key, e2eeDeviceKeyParamSchema);
const groupOf = (req: { params: { group: string } }) =>
  validateE2ee(req.params.group, e2eeGroupParamSchema);
const blobIdOf = (req: { params: { blob_id: string } }) =>
  validateE2ee(req.params.blob_id, e2eeBlobIdParamSchema);
const backupIdOf = (req: { params: { backup_id: string } }) =>
  validateE2ee(req.params.backup_id, e2eeBackupIdParamSchema);
const chunkIndexOf = (req: { params: { index: number } }) =>
  validateE2ee<number>(req.params.index, e2eeChunkIndexParamSchema);

function body<T>(value: unknown, schema: Joi.Schema): T {
  return validateE2ee(value, schema) as T;
}

export async function handleE2eeGetMe(
  req: E2eeGetMeRequest
): Promise<ApiE2eeMe> {
  return services.devices.getMe(await e2eeCaller(req));
}

export async function handleE2eeRegisterDevice(
  req: E2eeRegisterDeviceRequest
): Promise<ApiE2eeDevice> {
  const caller = await e2eeCaller(req);
  return services.devices.registerDevice(
    caller,
    body<ApiE2eeRegisterDeviceRequest>(req.body, e2eeRegisterDeviceSchema)
  );
}

export async function handleE2eeGetDevice(
  req: E2eeGetDeviceRequest
): Promise<ApiE2eeDevice> {
  await e2eeCaller(req);
  return services.devices.getDevice(deviceKeyOf(req));
}

export async function handleE2eeGetProfileDevices(
  req: E2eeGetProfileDevicesRequest
): Promise<ApiE2eeDevice[]> {
  await e2eeCaller(req);
  return services.devices.getProfileDevices(
    validateE2ee(req.params.profile_id, e2eeProfileIdParamSchema)
  );
}

export async function handleE2eeLookupDevices(
  req: E2eeLookupDevicesRequest
): Promise<ApiE2eeDeviceLookupResponse> {
  await e2eeCaller(req);
  return services.devices.lookupDevices(
    body<ApiE2eeDeviceLookupRequest>(req.body, e2eeDeviceLookupSchema)
  );
}

export async function handleE2eeRevokeDevice(
  req: E2eeRevokeDeviceRequest
): Promise<ApiE2eeDevice> {
  const caller = await e2eeCaller(req);
  return services.devices.revokeDevice(
    caller,
    deviceKeyOf(req),
    body<ApiE2eeRevokeDeviceRequest>(req.body, e2eeRevokeDeviceSchema)
  );
}

export async function handleE2eeUploadKeyPackages(
  req: E2eeUploadKeyPackagesRequest
): Promise<ApiE2eeKeyPackageStatus> {
  const caller = await e2eeCaller(req);
  return services.devices.uploadKeyPackages(
    caller,
    deviceKeyOf(req),
    body<ApiE2eeUploadKeyPackagesRequest>(req.body, e2eeUploadKeyPackagesSchema)
  );
}

export async function handleE2eeClaimKeyPackages(
  req: E2eeClaimKeyPackagesRequest
): Promise<ApiE2eeClaimKeyPackagesResponse> {
  const caller = await e2eeCaller(req);
  return services.devices.claimKeyPackages(
    caller,
    body<ApiE2eeClaimKeyPackagesRequest>(req.body, e2eeClaimKeyPackagesSchema)
  );
}

export async function handleE2eeCheckEligibility(
  req: E2eeCheckEligibilityRequest
): Promise<ApiE2eeEligibilityResponse> {
  const caller = await e2eeCaller(req);
  return services.devices.checkEligibility(
    caller,
    body<ApiE2eeEligibilityRequest>(req.body, e2eeEligibilitySchema)
  );
}

export async function handleE2eeCreateGroup(
  req: E2eeCreateGroupRequest
): Promise<ApiE2eeGroup> {
  const caller = await e2eeCaller(req);
  return services.groups.createGroup(
    caller,
    body<ApiE2eeCreateGroupRequest>(req.body, e2eeCreateGroupSchema)
  );
}

export async function handleE2eeGetGroup(
  req: E2eeGetGroupRequest
): Promise<ApiE2eeGroup> {
  const caller = await e2eeCaller(req);
  const query = body<{ device_key: string }>(req.query, e2eeDeviceQuerySchema);
  return services.groups.getGroup(caller, groupOf(req), query.device_key);
}

export async function handleE2eeSubmitEntry(
  req: E2eeSubmitEntryRequest
): Promise<ApiE2eeLogItem> {
  const caller = await e2eeCaller(req);
  return services.groups.submitEntry(
    caller,
    groupOf(req),
    body<ApiE2eeSubmitEntryRequest>(req.body, e2eeSubmitEntrySchema)
  );
}

export async function handleE2eeGetGroupLog(
  req: E2eeGetGroupLogRequest
): Promise<ApiE2eeLogPage> {
  const caller = await e2eeCaller(req);
  return services.groups.getLog(
    caller,
    groupOf(req),
    body<{ device_key: string; after_seq?: number; limit?: number }>(
      req.query,
      e2eeLogQuerySchema
    )
  );
}

export async function handleE2eeSendMessage(
  req: E2eeSendMessageRequest
): Promise<ApiE2eeSendMessageResponse> {
  const caller = await e2eeCaller(req);
  return services.groups.sendMessage(
    caller,
    groupOf(req),
    body<ApiE2eeSendMessageRequest>(req.body, e2eeSendMessageSchema)
  );
}

export async function handleE2eeRepairRoster(
  req: E2eeRepairRosterRequest
): Promise<ApiE2eeGroup> {
  const caller = await e2eeCaller(req);
  return services.groups.repairRoster(
    caller,
    groupOf(req),
    body<ApiE2eeRosterRepairRequest>(req.body, e2eeRosterRepairSchema)
  );
}

export async function handleE2eeGetWelcomes(
  req: E2eeGetWelcomesRequest
): Promise<ApiE2eeWelcome[]> {
  const caller = await e2eeCaller(req);
  return services.groups.getWelcomes(caller, deviceKeyOf(req));
}

export async function handleE2eeAckWelcome(
  req: E2eeAckWelcomeRequest
): Promise<ApiE2eeAck> {
  const caller = await e2eeCaller(req);
  const welcomeId = validateE2ee(
    req.params.welcome_id,
    Joi.string().pattern(E2EE_BLOB_ID_PATTERN).required()
  );
  return services.groups.ackWelcome(caller, deviceKeyOf(req), welcomeId);
}

export async function handleE2eeGetDeviceGroups(
  req: E2eeGetDeviceGroupsRequest
): Promise<ApiE2eeDeviceGroup[]> {
  const caller = await e2eeCaller(req);
  return services.groups.getDeviceGroups(caller, deviceKeyOf(req));
}

export async function handleE2eeCreateBlob(
  req: E2eeCreateBlobRequest
): Promise<ApiE2eeBlob> {
  const caller = await e2eeCaller(req);
  return services.blobs.createBlob(
    caller,
    body<ApiE2eeCreateBlobRequest>(req.body, e2eeCreateBlobSchema)
  );
}

export async function handleE2eePutBlobChunk(
  req: E2eePutBlobChunkRequest
): Promise<ApiE2eeBlob> {
  const caller = await e2eeCaller(req);
  return services.blobs.putChunk(
    caller,
    blobIdOf(req),
    chunkIndexOf(req),
    body<ApiE2eeBlobChunk>(req.body, e2eeBlobChunkSchema)
  );
}

export async function handleE2eeCompleteBlob(
  req: E2eeCompleteBlobRequest
): Promise<ApiE2eeBlob> {
  const caller = await e2eeCaller(req);
  return services.blobs.completeBlob(caller, blobIdOf(req));
}

export async function handleE2eeGetBlobChunk(
  req: E2eeGetBlobChunkRequest
): Promise<ApiE2eeBlobChunk> {
  const caller = await e2eeCaller(req);
  const query = body<{ device_key: string }>(req.query, e2eeDeviceQuerySchema);
  return services.blobs.getChunk(
    caller,
    blobIdOf(req),
    chunkIndexOf(req),
    query.device_key
  );
}

export async function handleE2eeReportMessage(
  req: E2eeReportMessageRequest
): Promise<ApiE2eeReport> {
  const caller = await e2eeCaller(req);
  return services.blobs.report(
    caller,
    body<ApiE2eeReportRequest>(req.body, e2eeReportSchema)
  );
}

// ------------------------------------------------- encrypted history backups

export async function handleE2eeGetBackupStatus(
  req: E2eeGetBackupStatusRequest
): Promise<ApiE2eeBackupStatus> {
  return services.backups.getStatus(await e2eeCaller(req));
}

export async function handleE2eeDeleteBackups(
  req: E2eeDeleteBackupsRequest
): Promise<ApiE2eeAck> {
  return services.backups.deleteAll(await e2eeCaller(req));
}

export async function handleE2eeCreateBackup(
  req: E2eeCreateBackupRequest
): Promise<ApiE2eeBackup> {
  const caller = await e2eeCaller(req);
  return services.backups.createBackup(
    caller,
    body<ApiE2eeCreateBackupRequest>(req.body, e2eeCreateBackupSchema)
  );
}

export async function handleE2eeGetBackup(
  req: E2eeGetBackupRequest
): Promise<ApiE2eeBackup> {
  const caller = await e2eeCaller(req);
  return services.backups.getBackup(caller, backupIdOf(req));
}

export async function handleE2eeActivateBackup(
  req: E2eeActivateBackupRequest
): Promise<ApiE2eeBackup> {
  const caller = await e2eeCaller(req);
  const request = body<{ device_key: string }>(
    req.body,
    e2eeBackupDeviceSchema
  );
  return services.backups.activate(caller, backupIdOf(req), request.device_key);
}

export async function handleE2eeListBackupChunks(
  req: E2eeListBackupChunksRequest
): Promise<ApiE2eeBackupChunkPage> {
  const caller = await e2eeCaller(req);
  return services.backups.listChunks(
    caller,
    backupIdOf(req),
    body<{ after_seq?: number; limit?: number }>(
      req.query,
      e2eeBackupChunkListQuerySchema
    )
  );
}

export async function handleE2eeAppendBackupChunk(
  req: E2eeAppendBackupChunkRequest
): Promise<ApiE2eeBackupChunk> {
  const caller = await e2eeCaller(req);
  return services.backups.appendChunk(
    caller,
    backupIdOf(req),
    body<ApiE2eeBackupChunkUpload>(req.body, e2eeBackupChunkUploadSchema)
  );
}

export async function handleE2eeGetBackupChunk(
  req: E2eeGetBackupChunkRequest
): Promise<ApiE2eeBackupChunkData> {
  const caller = await e2eeCaller(req);
  return services.backups.getChunk(
    caller,
    backupIdOf(req),
    validateE2ee<number>(req.params.seq, e2eeBackupSeqParamSchema)
  );
}

export async function handleE2eeCompactBackup(
  req: E2eeCompactBackupRequest
): Promise<ApiE2eeBackup> {
  const caller = await e2eeCaller(req);
  return services.backups.compact(
    caller,
    backupIdOf(req),
    body<ApiE2eeCompactBackupRequest>(req.body, e2eeCompactBackupSchema)
  );
}
