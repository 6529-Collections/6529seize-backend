import { ApiE2eeBlob } from '@/api/generated/models/ApiE2eeBlob';
import {
  ApiE2eeDevice,
  ApiE2eeDeviceVerifiedViaEnum
} from '@/api/generated/models/ApiE2eeDevice';
import { ApiE2eeDevicePlatform } from '@/api/generated/models/ApiE2eeDevicePlatform';
import { ApiE2eeEligibilityReasonEnum } from '@/api/generated/models/ApiE2eeEligibility';
import { ApiE2eeEligibilityStatus } from '@/api/generated/models/ApiE2eeEligibilityStatus';
import { ApiE2eeGroup } from '@/api/generated/models/ApiE2eeGroup';
import {
  ApiE2eeLogItem,
  ApiE2eeLogItemKindEnum,
  ApiE2eeLogItemTypeEnum
} from '@/api/generated/models/ApiE2eeLogItem';
import {
  E2eeBlobRow,
  E2eeDeviceRow,
  E2eeGroupRow,
  E2eeLogMetaRow,
  E2eeRosterRow
} from '@/e2ee/e2ee.db';
import { E2eeEntryKind } from '@/e2ee/e2ee-digests';
import { E2eeEligibilityStatus } from '@/e2ee/e2ee-policy';
import { DirectMessageRefusalReason } from '@/direct-messages/direct-message-admission';

const PLATFORMS: Record<string, ApiE2eeDevicePlatform> = {
  web: ApiE2eeDevicePlatform.Web,
  desktop: ApiE2eeDevicePlatform.Desktop,
  phone: ApiE2eeDevicePlatform.Phone
};

const STATUSES: Record<E2eeEligibilityStatus, ApiE2eeEligibilityStatus> = {
  [E2eeEligibilityStatus.OK]: ApiE2eeEligibilityStatus.Ok,
  [E2eeEligibilityStatus.POLICY]: ApiE2eeEligibilityStatus.Policy,
  [E2eeEligibilityStatus.BLOCKED]: ApiE2eeEligibilityStatus.Blocked,
  [E2eeEligibilityStatus.NO_DEVICES]: ApiE2eeEligibilityStatus.NoDevices
};

// Same values as DIRECT_MESSAGE_ADMISSION_ERROR_CODES (the legacy DM codes).
const REASONS: Record<
  DirectMessageRefusalReason,
  ApiE2eeEligibilityReasonEnum
> = {
  [DirectMessageRefusalReason.NOT_ACCEPTING]:
    ApiE2eeEligibilityReasonEnum.RecipientNotAccepting,
  [DirectMessageRefusalReason.PEOPLE_I_FOLLOW_ONLY]:
    ApiE2eeEligibilityReasonEnum.RecipientPeopleIFollowOnly,
  [DirectMessageRefusalReason.GROUP_MEMBERS_ONLY]:
    ApiE2eeEligibilityReasonEnum.RecipientGroupMembersOnly,
  [DirectMessageRefusalReason.SENDER_BLOCKED_RECIPIENT]:
    ApiE2eeEligibilityReasonEnum.SenderBlockedRecipient
};

/** The shared DM admission code behind a POLICY or BLOCKED status. */
export function toApiEligibilityReason(
  reason: DirectMessageRefusalReason
): ApiE2eeEligibilityReasonEnum {
  return REASONS[reason];
}

export function toApiEligibilityStatus(
  status: E2eeEligibilityStatus
): ApiE2eeEligibilityStatus {
  return STATUSES[status];
}

export function toApiE2eeDevice(row: E2eeDeviceRow): ApiE2eeDevice {
  return {
    device_key: row.device_key,
    profile_id: row.profile_id,
    grant: {
      wallet: row.wallet,
      device_key: row.device_key,
      ciphersuite: Number(row.ciphersuite),
      issued_at: Number(row.issued_at_seconds),
      expires_at: Number(row.expires_at_seconds),
      origin: row.origin
    },
    grant_id: row.grant_id,
    wallet_signature: row.wallet_signature,
    verified_via:
      row.verified_via === 'eip1271'
        ? ApiE2eeDeviceVerifiedViaEnum.Eip1271
        : ApiE2eeDeviceVerifiedViaEnum.Eoa,
    label: row.label,
    platform: PLATFORMS[row.platform] ?? ApiE2eeDevicePlatform.Web,
    created_at: Number(row.created_at),
    last_seen_at: row.last_seen_at === null ? null : Number(row.last_seen_at),
    revoked_at: row.revoked_at === null ? null : Number(row.revoked_at),
    revocation:
      row.revoked_at !== null &&
      row.revoker_device_key !== null &&
      row.revocation_signed_at_seconds !== null &&
      row.revocation_signature !== null
        ? {
            revoker_device_key: row.revoker_device_key,
            revoked_at: Number(row.revocation_signed_at_seconds),
            signature: row.revocation_signature
          }
        : null,
    grant_message: row.grant_message ?? null
  };
}

export function toApiE2eeGroup(
  group: E2eeGroupRow,
  roster: readonly E2eeRosterRow[]
): ApiE2eeGroup {
  return {
    group: group.group_handle,
    epoch: Number(group.epoch),
    commit_key: group.commit_key,
    last_seq: Number(group.last_seq),
    created_at: Number(group.created_at),
    updated_at: Number(group.updated_at),
    roster: roster.map((row) => ({
      device_key: row.device_key,
      profile_id: row.profile_id,
      joined_epoch: Number(row.joined_epoch)
    }))
  };
}

function parseKeyList(value: string | null): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((it): it is string => typeof it === 'string')
    : [];
}

function toApiKind(kind: number | null): ApiE2eeLogItemKindEnum | null {
  if (kind === E2eeEntryKind.COMMIT) return ApiE2eeLogItemKindEnum.Commit;
  if (kind === E2eeEntryKind.PROPOSAL) return ApiE2eeLogItemKindEnum.Proposal;
  return null;
}

function rowKind(row: { kind: number | string | null }): number | null {
  return row.kind === null ? null : Number(row.kind);
}

export function toApiE2eeLogItem(
  row: E2eeLogMetaRow,
  dataBase64: string
): ApiE2eeLogItem {
  const isEntry = row.item_type === 'entry';
  return {
    seq: Number(row.seq),
    type: isEntry
      ? ApiE2eeLogItemTypeEnum.Entry
      : ApiE2eeLogItemTypeEnum.Message,
    epoch: Number(row.epoch),
    kind: isEntry ? toApiKind(rowKind(row)) : null,
    data: dataBase64,
    entry_hash: row.entry_hash,
    epoch_commitment: row.epoch_commitment,
    next_commit_key: row.next_commit_key,
    signature: row.signature,
    roster_add: parseKeyList(row.roster_add),
    roster_remove: parseKeyList(row.roster_remove),
    epoch_fp: row.epoch_fp,
    created_at: Number(row.created_at)
  };
}

export function toApiE2eeBlob(row: E2eeBlobRow): ApiE2eeBlob {
  return {
    blob_id: row.blob_id,
    group: row.group_handle,
    size: Number(row.size),
    chunk_count: Number(row.chunk_count),
    complete: !!row.complete,
    created_at: Number(row.created_at)
  };
}
