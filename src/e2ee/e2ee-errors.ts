import { ApiErrorDetails, CustomApiCompliantException } from '@/exceptions';
import { E2EE_ERROR_CODES } from '@/e2ee/e2ee.constants';
import {
  DIRECT_MESSAGE_ADMISSION_ERROR_CODES,
  DirectMessageRefusalReason
} from '@/direct-messages/direct-message-admission';

/** The shared DM admission code (DM_*) as error details, when known. */
function admissionDetails(reason?: DirectMessageRefusalReason) {
  return reason
    ? { reason: DIRECT_MESSAGE_ADMISSION_ERROR_CODES[reason] }
    : undefined;
}

export type E2eeErrorCode =
  (typeof E2EE_ERROR_CODES)[keyof typeof E2EE_ERROR_CODES];

export class E2eeApiException extends CustomApiCompliantException {
  constructor(
    status: number,
    readonly e2eeCode: E2eeErrorCode,
    message: string,
    details?: ApiErrorDetails
  ) {
    super(status, message, e2eeCode, details);
  }
}

export const e2eeErrors = {
  disabled: () =>
    new E2eeApiException(
      404,
      E2EE_ERROR_CODES.DISABLED,
      'Encrypted messaging is not available'
    ),
  forbidden: (message: string) =>
    new E2eeApiException(403, E2EE_ERROR_CODES.FORBIDDEN, message),
  notYourDevice: () =>
    new E2eeApiException(
      403,
      E2EE_ERROR_CODES.NOT_YOUR_DEVICE,
      'The device is not an active device of your profile'
    ),
  deviceLimit: (max: number) =>
    new E2eeApiException(
      409,
      E2EE_ERROR_CODES.DEVICE_LIMIT,
      `A profile can have at most ${max} active encrypted-messaging devices`
    ),
  deviceExists: () =>
    new E2eeApiException(
      409,
      E2EE_ERROR_CODES.DEVICE_EXISTS,
      'The device key is already registered'
    ),
  keyPackageLimit: (max: number) =>
    new E2eeApiException(
      409,
      E2EE_ERROR_CODES.KEY_PACKAGE_LIMIT,
      `A device can have at most ${max} unclaimed one-time KeyPackages`
    ),
  badGrant: (reason: string) =>
    new E2eeApiException(
      400,
      E2EE_ERROR_CODES.BAD_GRANT,
      `The device grant is invalid (${reason})`
    ),
  badSignature: (what: string) =>
    new E2eeApiException(
      400,
      E2EE_ERROR_CODES.BAD_SIGNATURE,
      `The ${what} signature is invalid`
    ),
  badRequest: (message: string) =>
    new E2eeApiException(400, E2EE_ERROR_CODES.BAD_REQUEST, message),
  epochConflict: (currentEpoch: number) =>
    new E2eeApiException(
      409,
      E2EE_ERROR_CODES.EPOCH_CONFLICT,
      'Another change was already sequenced for this epoch',
      { current_epoch: currentEpoch }
    ),
  epochStale: (currentEpoch: number) =>
    new E2eeApiException(
      409,
      E2EE_ERROR_CODES.EPOCH_STALE,
      'The group has moved to a newer epoch',
      { current_epoch: currentEpoch }
    ),
  notMember: () =>
    new E2eeApiException(
      404,
      E2EE_ERROR_CODES.NOT_MEMBER,
      'The device is not a member of this group'
    ),
  /**
   * The target does not admit the caller. A target's block of the caller is
   * reported here too, with the same copy as a NOBODY policy, so it is never
   * disclosed.
   */
  policy: (profileId?: string, reason?: DirectMessageRefusalReason) =>
    new E2eeApiException(
      403,
      E2EE_ERROR_CODES.POLICY,
      profileId
        ? `Profile ${profileId} does not accept encrypted messages from you`
        : 'The recipient does not accept encrypted messages from you',
      admissionDetails(reason)
    ),
  /** Only the caller's own block of the target, which the caller can undo. */
  blocked: (profileId?: string) =>
    new E2eeApiException(
      403,
      E2EE_ERROR_CODES.BLOCKED,
      profileId
        ? `You have blocked profile ${profileId}. Unblock them to message them`
        : 'You have blocked the recipient. Unblock them to message them',
      admissionDetails(DirectMessageRefusalReason.SENDER_BLOCKED_RECIPIENT)
    ),
  tooLarge: (what: string) =>
    new E2eeApiException(
      413,
      E2EE_ERROR_CODES.TOO_LARGE,
      `${what} is too large`
    ),
  rateLimited: () =>
    new E2eeApiException(
      429,
      E2EE_ERROR_CODES.RATE_LIMITED,
      'Too many encrypted-messaging requests; try again later'
    ),
  attachmentsDisabled: () =>
    new E2eeApiException(
      404,
      E2EE_ERROR_CODES.ATTACHMENTS_DISABLED,
      'Encrypted attachments are not available'
    ),
  backupsDisabled: () =>
    new E2eeApiException(
      404,
      E2EE_ERROR_CODES.BACKUPS_DISABLED,
      'Encrypted message backups are not available'
    ),
  backupQuota: (quotaBytes: number) =>
    new E2eeApiException(
      413,
      E2EE_ERROR_CODES.BACKUP_QUOTA,
      'The encrypted backup storage quota is used up',
      { quota_bytes: quotaBytes }
    ),
  notFound: (what: string) =>
    new E2eeApiException(404, E2EE_ERROR_CODES.NOT_FOUND, `${what} not found`),
  /** Attachment storage is misconfigured or unreachable (fails closed). */
  storageUnavailable: () =>
    new E2eeApiException(
      503,
      E2EE_ERROR_CODES.STORAGE_UNAVAILABLE,
      'Encrypted attachment storage is unavailable; try again later'
    )
};
