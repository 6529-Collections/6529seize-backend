import * as Joi from 'joi';
import {
  E2EE_BACKUP_LIST_MAX_LIMIT,
  E2EE_CIPHERSUITE,
  E2EE_DEVICE_PLATFORMS,
  E2EE_GRANT_ORIGIN_MAX_LENGTH,
  E2EE_LOG_MAX_LIMIT,
  E2EE_MAX_BLOB_CHUNKS,
  E2EE_MAX_CLAIM_TARGETS,
  E2EE_MAX_ELIGIBILITY_PROFILES,
  E2EE_MAX_KEY_PACKAGES_PER_UPLOAD,
  E2EE_MAX_NOTIFY_HINTS,
  E2EE_MAX_REPORT_NOTES_LENGTH,
  E2EE_MAX_ROSTER_DELTA,
  E2EE_MAX_ROSTER_DEVICES
} from '@/e2ee/e2ee.constants';
import {
  E2EE_BLOB_ID_PATTERN,
  E2EE_EPOCH_FP_PATTERN,
  E2EE_HEX32_PATTERN,
  E2EE_SIG64_PATTERN,
  E2EE_WALLET_PATTERN,
  E2EE_WALLET_SIGNATURE_PATTERN
} from '@/e2ee/e2ee-encoding';
import { e2eeErrors } from '@/e2ee/e2ee-errors';
import { ApiE2eeReportCategory } from '@/api/generated/models/ApiE2eeReportCategory';

const UINT32_MAX = 4294967295;

const hex32 = () => Joi.string().pattern(E2EE_HEX32_PATTERN);
const sig64 = () => Joi.string().pattern(E2EE_SIG64_PATTERN);
const epoch = () => Joi.number().integer().min(0).max(UINT32_MAX);
const base64 = () => Joi.string().allow('');
const profileId = () => Joi.string().trim().min(1).max(100);
const unixSeconds = () =>
  Joi.number().integer().min(1).max(Number.MAX_SAFE_INTEGER);
const deviceKeyList = (max: number) => Joi.array().items(hex32()).max(max);

export function validateE2ee<T>(value: unknown, schema: Joi.Schema<T>): T {
  const { error, value: validated } = schema.validate(value, {
    abortEarly: true
  });
  if (error) throw e2eeErrors.badRequest(error.message);
  return validated;
}

export const e2eeDeviceKeyParamSchema = hex32().required();
export const e2eeGroupParamSchema = hex32().required();
export const e2eeBlobIdParamSchema = Joi.string()
  .pattern(E2EE_BLOB_ID_PATTERN)
  .required();
export const e2eeChunkIndexParamSchema = Joi.number()
  .integer()
  .min(0)
  .max(E2EE_MAX_BLOB_CHUNKS - 1)
  .required();
export const e2eeProfileIdParamSchema = profileId().required();

export const e2eeDeviceQuerySchema = Joi.object({
  device_key: hex32().required()
});

export const e2eeLogQuerySchema = Joi.object({
  device_key: hex32().required(),
  after_seq: Joi.number().integer().min(0).default(0),
  limit: Joi.number().integer().min(1).max(E2EE_LOG_MAX_LIMIT).optional()
});

export const e2eeRegisterDeviceSchema = Joi.object({
  grant: Joi.object({
    wallet: Joi.string().pattern(E2EE_WALLET_PATTERN).required(),
    device_key: hex32().required(),
    ciphersuite: Joi.number().integer().valid(E2EE_CIPHERSUITE).required(),
    issued_at: unixSeconds().required(),
    expires_at: unixSeconds().required(),
    origin: Joi.string().min(1).max(E2EE_GRANT_ORIGIN_MAX_LENGTH).required()
  }).required(),
  wallet_signature: Joi.string()
    .pattern(E2EE_WALLET_SIGNATURE_PATTERN)
    .max(20002)
    .required(),
  label: Joi.string().allow('').max(200).optional(),
  platform: Joi.string()
    .valid(...E2EE_DEVICE_PLATFORMS)
    .required()
});

export const e2eeDeviceLookupSchema = Joi.object({
  profile_ids: Joi.array().items(profileId()).max(200).optional(),
  device_keys: deviceKeyList(500).optional()
})
  .or('profile_ids', 'device_keys')
  .custom(
    (value: { profile_ids?: string[]; device_keys?: string[] }, helpers) =>
      (value.profile_ids?.length ?? 0) + (value.device_keys?.length ?? 0) > 0
        ? value
        : helpers.error('any.invalid')
  )
  .messages({ 'any.invalid': 'Give at least one profile id or device key' });

export const e2eeRevokeDeviceSchema = Joi.object({
  revoker_device_key: hex32().required(),
  revoked_at: unixSeconds().required(),
  signature: sig64().required()
});

export const e2eeUploadKeyPackagesSchema = Joi.object({
  key_packages: Joi.array()
    .items(
      Joi.object({
        data: base64().required(),
        last_resort: Joi.boolean().required(),
        expires_at: unixSeconds().required()
      })
    )
    .min(1)
    .max(E2EE_MAX_KEY_PACKAGES_PER_UPLOAD)
    .required()
});

export const e2eeClaimKeyPackagesSchema = Joi.object({
  targets: Joi.array()
    .items(
      Joi.object({
        profile_id: profileId().required(),
        device_keys: deviceKeyList(E2EE_MAX_ROSTER_DEVICES).optional()
      })
    )
    .min(1)
    .max(E2EE_MAX_CLAIM_TARGETS)
    .unique('profile_id')
    .required(),
  group: hex32().optional(),
  claimer_device_key: hex32().required()
});

export const e2eeEligibilitySchema = Joi.object({
  profile_ids: Joi.array()
    .items(profileId())
    .min(1)
    .max(E2EE_MAX_ELIGIBILITY_PROFILES)
    .required()
});

export const e2eeCreateGroupSchema = Joi.object({
  group: hex32().required(),
  commit_key: hex32().required(),
  creator_device_key: hex32().required()
});

export const e2eeSubmitEntrySchema = Joi.object({
  kind: Joi.string().valid('commit', 'proposal').required(),
  epoch: epoch().required(),
  data: base64().required(),
  entry_hash: hex32().required(),
  epoch_commitment: hex32().required(),
  next_commit_key: hex32().required(),
  signature: sig64().required(),
  sender_device_key: hex32().required(),
  roster_add: deviceKeyList(E2EE_MAX_ROSTER_DELTA).optional(),
  roster_remove: deviceKeyList(E2EE_MAX_ROSTER_DELTA).optional(),
  welcome: Joi.object({
    data: base64().required(),
    ratchet_tree: base64().optional(),
    targets: deviceKeyList(E2EE_MAX_ROSTER_DELTA).min(1).required()
  }).optional()
});

export const e2eeSendMessageSchema = Joi.object({
  epoch: epoch().required(),
  data: base64().required(),
  epoch_fp: Joi.string().pattern(E2EE_EPOCH_FP_PATTERN).required(),
  sender_device_key: hex32().required(),
  notify: Joi.array()
    .items(
      Joi.object({
        profile_id: profileId().required(),
        kind: Joi.string().valid('message', 'mention', 'reply').required()
      })
    )
    .max(E2EE_MAX_NOTIFY_HINTS)
    .optional()
});

export const e2eeRosterRepairSchema = Joi.object({
  epoch: epoch().required(),
  device_keys: deviceKeyList(E2EE_MAX_ROSTER_DEVICES).min(1).required(),
  requester_device_key: hex32().required(),
  signature: sig64().required()
});

export const e2eeCreateBlobSchema = Joi.object({
  group: hex32().required(),
  uploader_device_key: hex32().required(),
  size: Joi.number().integer().min(1).required(),
  chunk_count: Joi.number().integer().min(1).required()
});

export const e2eeBlobChunkSchema = Joi.object({
  data: base64().required()
});

export const e2eeReportSchema = Joi.object({
  group: hex32().required(),
  epoch: epoch().required(),
  body: base64().required(),
  signature: sig64().required(),
  sender_device_key: hex32().required(),
  reporter_device_key: hex32().required(),
  reason: Joi.string()
    .valid(...Object.values(ApiE2eeReportCategory))
    .required(),
  notes: Joi.string().allow('').max(E2EE_MAX_REPORT_NOTES_LENGTH).optional()
});

export const e2eeBackupIdParamSchema = Joi.string()
  .pattern(E2EE_BLOB_ID_PATTERN)
  .required();
export const e2eeBackupSeqParamSchema = Joi.number()
  .integer()
  .min(1)
  .max(UINT32_MAX)
  .required();

export const e2eeCreateBackupSchema = Joi.object({
  backup_id: Joi.string().pattern(E2EE_BLOB_ID_PATTERN).required(),
  envelope: base64().required(),
  device_key: hex32().required()
});

export const e2eeBackupChunkUploadSchema = Joi.object({
  device_key: hex32().required(),
  data: base64().required()
});

export const e2eeBackupDeviceSchema = Joi.object({
  device_key: hex32().required()
});

export const e2eeCompactBackupSchema = Joi.object({
  device_key: hex32().required(),
  through_seq: Joi.number().integer().min(1).max(UINT32_MAX).required()
});

export const e2eeBackupChunkListQuerySchema = Joi.object({
  after_seq: Joi.number().integer().min(0).max(UINT32_MAX).default(0),
  limit: Joi.number()
    .integer()
    .min(1)
    .max(E2EE_BACKUP_LIST_MAX_LIMIT)
    .optional()
});
