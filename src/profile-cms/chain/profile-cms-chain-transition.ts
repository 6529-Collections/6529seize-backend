import { createHash } from 'node:crypto';
import {
  ProfileCmsPackageEntity,
  ProfileCmsPackageStatus
} from '@/entities/IProfileCmsPackage';
import {
  ProfileCmsPointerEventEntity,
  ProfileCmsPointerEventType
} from '@/entities/IProfileCmsPointerEvent';
import { ProfileCmsPublishSignatureEntity } from '@/entities/IProfileCmsPublishSignature';
import { cmsHashFromCid } from '@/profile-cms/chain/profile-cms-cid';
import {
  CheckedProfileCmsPublication,
  publicationRecoveryReceipt
} from '@/profile-cms/chain/profile-cms-publication-check';

/** The site a new ProfileDoc version names, after the reader's checks. */
export type ProfileCmsChainTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | {
      readonly kind: 'publication';
      readonly checked: CheckedProfileCmsPublication;
    };

export interface ProfileCmsChainTransitionInput {
  readonly profileId: string;
  readonly principal: string;
  readonly height: number;
  readonly timeMs: number;
  readonly version: number;
  /** The new document's CID; null when the person erased their document. */
  readonly docCid: string | null;
  /** The profile's primary package row before this change. */
  readonly currentPrimary: ProfileCmsPackageEntity | null;
  /** The row the publication names (by its draft id), if it exists. */
  readonly targetRow: ProfileCmsPackageEntity | null;
  readonly target: ProfileCmsChainTarget;
}

export interface ProfileCmsChainTransition {
  readonly packages: readonly ProfileCmsPackageEntity[];
  readonly events: readonly ProfileCmsPointerEventEntity[];
  readonly signature: ProfileCmsPublishSignatureEntity | null;
  /** Why a named site was not served; null when nothing was refused. */
  readonly refused: string | null;
}

const NO_CHANGE: ProfileCmsChainTransition = {
  packages: [],
  events: [],
  signature: null,
  refused: null
};

/**
 * The index changes one ProfileDoc version makes to a profile's site, as a
 * pure function of the rows before it and the checked publication. The live
 * follower and the rebuild both call it, so they write the same rows.
 *
 * - A publication never published before: PUBLISH, SUPERSEDE of the old
 *   primary, SET_PRIMARY (6529.io's publish triple).
 * - A publication published before: ROLLBACK, SUPERSEDE, SET_PRIMARY.
 * - No site, or a site that fails the checks: UNPUBLISH of the old primary.
 * - The same publication as the current primary: nothing.
 */
export function profileCmsChainTransition(
  input: ProfileCmsChainTransitionInput
): ProfileCmsChainTransition {
  const { target, currentPrimary } = input;
  if (target.kind !== 'publication') {
    const refused = target.kind === 'invalid' ? target.reason : null;
    return currentPrimary
      ? { ...unpublish(input, currentPrimary), refused }
      : { ...NO_CHANGE, refused };
  }
  const { checked } = target;
  if (currentPrimary?.publication_cid === checked.publication_cid) {
    return NO_CHANGE;
  }
  const conflict = targetConflict(input, checked);
  if (conflict) {
    return currentPrimary
      ? { ...unpublish(input, currentPrimary), refused: conflict }
      : { ...NO_CHANGE, refused: conflict };
  }
  if (currentPrimary && currentPrimary.id === input.targetRow?.id) {
    // The same package under a newer publication record: keep it primary.
    return {
      ...NO_CHANGE,
      packages: [withPublication(currentPrimary, checked, input.timeMs)]
    };
  }
  const wasPublished =
    input.targetRow !== null && input.targetRow.published_at !== null;
  return wasPublished
    ? rollback(input, input.targetRow as ProfileCmsPackageEntity, checked)
    : publish(input, checked);
}

function targetConflict(
  input: ProfileCmsChainTransitionInput,
  checked: CheckedProfileCmsPublication
): string | null {
  const row = input.targetRow;
  if (!row) {
    return null;
  }
  if (row.profile_id !== input.profileId) {
    return 'package_row_of_another_profile';
  }
  if (row.package_hash !== checked.publication.package_hash) {
    return 'package_row_hash_mismatch';
  }
  return null;
}

function publish(
  input: ProfileCmsChainTransitionInput,
  checked: CheckedProfileCmsPublication
): ProfileCmsChainTransition {
  const { currentPrimary, timeMs } = input;
  const published = publishedRow(input, checked);
  const previousId = currentPrimary?.id ?? null;
  const signed = signedEventFields(checked);
  const events = [
    event(
      input,
      0,
      ProfileCmsPointerEventType.PUBLISH,
      published,
      previousId,
      signed
    ),
    ...(currentPrimary
      ? [
          event(
            input,
            1,
            ProfileCmsPointerEventType.SUPERSEDE,
            currentPrimary,
            published.id,
            signed
          )
        ]
      : []),
    event(
      input,
      currentPrimary ? 2 : 1,
      ProfileCmsPointerEventType.SET_PRIMARY,
      published,
      previousId,
      signed
    )
  ];
  return {
    packages: [
      ...(currentPrimary
        ? [superseded(currentPrimary, published.id, timeMs)]
        : []),
      published
    ],
    events,
    signature: {
      id: `chain-${checked.typed_data_hash}`,
      typed_data_hash: checked.typed_data_hash,
      profile_id: input.profileId,
      package_db_id: published.id,
      package_id: published.package_id,
      package_version: published.version,
      package_hash: published.package_hash,
      signer_address: checked.signer_address,
      deadline: checked.deadline,
      created_at: timeMs
    },
    refused: null
  };
}

function rollback(
  input: ProfileCmsChainTransitionInput,
  targetRow: ProfileCmsPackageEntity,
  checked: CheckedProfileCmsPublication
): ProfileCmsChainTransition {
  const { currentPrimary, timeMs } = input;
  const primary: ProfileCmsPackageEntity = {
    ...withPublication(targetRow, checked, timeMs),
    status: ProfileCmsPackageStatus.PUBLISHED,
    is_primary: true,
    superseded_by_id: null,
    updated_at: timeMs
  };
  const previousId = currentPrimary?.id ?? null;
  const events = [
    event(
      input,
      0,
      ProfileCmsPointerEventType.ROLLBACK,
      primary,
      previousId,
      null
    ),
    ...(currentPrimary
      ? [
          event(
            input,
            1,
            ProfileCmsPointerEventType.SUPERSEDE,
            currentPrimary,
            primary.id,
            null
          )
        ]
      : []),
    event(
      input,
      currentPrimary ? 2 : 1,
      ProfileCmsPointerEventType.SET_PRIMARY,
      primary,
      previousId,
      null
    )
  ];
  return {
    packages: [
      ...(currentPrimary
        ? [superseded(currentPrimary, primary.id, timeMs)]
        : []),
      primary
    ],
    events,
    signature: null,
    refused: null
  };
}

function unpublish(
  input: ProfileCmsChainTransitionInput,
  currentPrimary: ProfileCmsPackageEntity
): Omit<ProfileCmsChainTransition, 'refused'> {
  return {
    packages: [
      {
        ...currentPrimary,
        is_primary: false,
        status: ProfileCmsPackageStatus.SUPERSEDED,
        updated_at: input.timeMs
      }
    ],
    events: [
      event(
        input,
        0,
        ProfileCmsPointerEventType.UNPUBLISH,
        currentPrimary,
        currentPrimary.id,
        null
      )
    ],
    signature: null
  };
}

function publishedRow(
  input: ProfileCmsChainTransitionInput,
  checked: CheckedProfileCmsPublication
): ProfileCmsPackageEntity {
  const { publication, cms_package, canonical_receipt } = checked;
  const { timeMs } = input;
  const draft = input.targetRow;
  return {
    id: publication.package_db_id,
    profile_id: input.profileId,
    profile_handle: publication.profile_handle,
    package_id: publication.package_id,
    version: publication.version,
    status: ProfileCmsPackageStatus.PUBLISHED,
    cms_package,
    payload_hash: publication.payload_hash,
    package_hash: publication.package_hash,
    primary_path: publication.primary_path,
    is_primary: true,
    production_valid: true,
    created_by_profile_id: draft?.created_by_profile_id ?? input.profileId,
    published_by_profile_id: input.profileId,
    created_at: draft?.created_at ?? publication.published_at,
    updated_at: timeMs,
    validated_at: timeMs,
    published_at: timeMs,
    failed_at: null,
    archived_at: draft?.archived_at ?? null,
    superseded_by_id: null,
    validation_result: checked.validation_result,
    validation_error: null,
    storage_receipts: cms_package.storage,
    storage_provider: canonical_receipt.provider,
    storage_uri: canonical_receipt.uri,
    storage_content_hash: canonical_receipt.content_hash,
    storage_provider_content_id: canonical_receipt.provider_content_id ?? null,
    storage_recorded_at: canonical_receipt.recorded_at,
    storage_pinned: canonical_receipt.pinned ?? null,
    storage_canonical: canonical_receipt.canonical ?? null,
    recovery_receipt: recoveryReceipt(checked, timeMs),
    publication_cid: checked.publication_cid
  };
}

function withPublication(
  row: ProfileCmsPackageEntity,
  checked: CheckedProfileCmsPublication,
  timeMs: number
): ProfileCmsPackageEntity {
  if (row.publication_cid === checked.publication_cid) {
    return row;
  }
  return {
    ...row,
    publication_cid: checked.publication_cid,
    recovery_receipt: recoveryReceipt(checked, timeMs)
  };
}

function superseded(
  row: ProfileCmsPackageEntity,
  supersededById: string,
  timeMs: number
): ProfileCmsPackageEntity {
  return {
    ...row,
    status: ProfileCmsPackageStatus.SUPERSEDED,
    is_primary: false,
    superseded_by_id: supersededById,
    updated_at: timeMs
  };
}

function recoveryReceipt(
  checked: CheckedProfileCmsPublication,
  timeMs: number
): unknown {
  return publicationRecoveryReceipt(
    checked.publication_cid,
    cmsHashFromCid(checked.publication_cid) as string,
    timeMs
  );
}

type SignedEventFields = Pick<
  ProfileCmsPointerEventEntity,
  | 'signer_address'
  | 'signature'
  | 'typed_data'
  | 'typed_data_hash'
  | 'storage_receipt'
>;

function signedEventFields(
  checked: CheckedProfileCmsPublication
): SignedEventFields {
  return {
    signer_address: checked.signer_address,
    signature: checked.publication.signature,
    typed_data: checked.typed_data,
    typed_data_hash: checked.typed_data_hash,
    storage_receipt: checked.canonical_receipt
  };
}

function event(
  input: ProfileCmsChainTransitionInput,
  sequence: number,
  eventType: ProfileCmsPointerEventType,
  row: ProfileCmsPackageEntity,
  previousPackageDbId: string | null,
  signed: SignedEventFields | null
): ProfileCmsPointerEventEntity {
  return {
    id: chainEventId(input.principal, input.version, sequence),
    event_type: eventType,
    profile_id: row.profile_id,
    profile_handle: row.profile_handle,
    package_db_id: row.id,
    package_id: row.package_id,
    package_version: row.version,
    package_hash: row.package_hash,
    payload_hash: row.payload_hash,
    previous_package_db_id: previousPackageDbId,
    actor_profile_id: input.profileId,
    signer_address: signed?.signer_address ?? null,
    signature: signed?.signature ?? null,
    typed_data: signed?.typed_data ?? null,
    typed_data_hash: signed?.typed_data_hash ?? null,
    storage_receipt: signed?.storage_receipt ?? null,
    event_sequence: sequence,
    created_at: input.timeMs,
    chain_height: input.height,
    doc_cid: input.docCid
  };
}

/**
 * Deterministic, so a rebuild writes the same event ids the live follower
 * wrote. Keyed on the document version, so two versions with the same bytes
 * still get their own events.
 */
function chainEventId(
  principal: string,
  version: number,
  sequence: number
): string {
  const digest = createHash('sha256')
    .update(`${principal}:${version}:${sequence}`)
    .digest('hex');
  return `chain-${digest.slice(0, 40)}`;
}
