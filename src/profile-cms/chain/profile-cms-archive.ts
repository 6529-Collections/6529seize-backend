import { z } from 'zod';
import { CmsPublishedPackageRow } from '@/api/cms/cms.db';
import {
  ProfileCmsPackageEntity,
  ProfileCmsPackageStatus
} from '@/entities/IProfileCmsPackage';
import {
  ProfileCmsPointerEventEntity,
  ProfileCmsPointerEventType
} from '@/entities/IProfileCmsPointerEvent';
import { isCmsCid } from '@/profile-cms/chain/profile-cms-cid';
import {
  canonicalizeJson,
  CmsPackageV1,
  integritySchema,
  signatureEnvelopeSchema,
  storageReceiptSchema
} from '@/profile-cms/protocol/v1';

/**
 * `6529.cms.archive.v1`: one person's 6529.io site history at the identity
 * freeze, named by `cms.archive` in their imported ProfileDoc. It holds only
 * what 6529.io's public API serves or has published: packages that were ever
 * published, their pointer events and publish signatures, and the legacy CMS
 * sites with published packages. Drafts stay out.
 *
 * Package contents are files of their own: each package row names its content
 * core by CID and carries the envelope (integrity, signatures, storage) inline;
 * each legacy package names its package JSON by CID.
 */
export const PROFILE_CMS_ARCHIVE_SCHEMA = '6529.cms.archive.v1' as const;

const cid = z.string().refine(isCmsCid, 'not a raw sha2-256 CIDv1');
const millis = z.number().int().nonnegative();
const nullableMillis = millis.nullable();
const json = z.unknown();

const archivePackageSchema = z
  .object({
    id: z.string().min(1).max(100),
    profile_id: z.string().min(1).max(100),
    profile_handle: z.string().max(100),
    package_id: z.string().min(1).max(128),
    version: z.number().int().nonnegative(),
    status: z.nativeEnum(ProfileCmsPackageStatus),
    package: cid,
    envelope: z
      .object({
        integrity: integritySchema,
        signatures: z.array(signatureEnvelopeSchema),
        storage: z.array(storageReceiptSchema)
      })
      .strict(),
    publication: cid.nullable(),
    publication_rebuilt: z.boolean(),
    payload_hash: z.string(),
    package_hash: z.string(),
    primary_path: z.string(),
    is_primary: z.boolean(),
    production_valid: z.boolean(),
    created_by_profile_id: z.string(),
    published_by_profile_id: z.string().nullable(),
    created_at: millis,
    updated_at: millis,
    validated_at: nullableMillis,
    published_at: millis,
    failed_at: nullableMillis,
    archived_at: nullableMillis,
    superseded_by_id: z.string().nullable(),
    validation_result: json,
    validation_error: z.string().nullable(),
    storage_receipts: json,
    storage_provider: z.string().nullable(),
    storage_uri: z.string().nullable(),
    storage_content_hash: z.string().nullable(),
    storage_provider_content_id: z.string().nullable(),
    storage_recorded_at: z.string().nullable(),
    storage_pinned: z.boolean().nullable(),
    storage_canonical: z.boolean().nullable(),
    recovery_receipt: json
  })
  .strict();

const archivePointerEventSchema = z
  .object({
    id: z.string().min(1).max(100),
    event_type: z.nativeEnum(ProfileCmsPointerEventType),
    profile_id: z.string(),
    profile_handle: z.string(),
    package_db_id: z.string(),
    package_id: z.string(),
    package_version: z.number().int(),
    package_hash: z.string(),
    payload_hash: z.string(),
    previous_package_db_id: z.string().nullable(),
    actor_profile_id: z.string(),
    signer_address: z.string().nullable(),
    signature: z.string().nullable(),
    typed_data: json,
    typed_data_hash: z.string().nullable(),
    storage_receipt: json,
    event_sequence: z.number().int(),
    created_at: millis
  })
  .strict();

const archivePublishSignatureSchema = z
  .object({
    id: z.string().min(1).max(100),
    typed_data_hash: z.string(),
    profile_id: z.string(),
    package_db_id: z.string(),
    package_id: z.string(),
    package_version: z.number().int(),
    package_hash: z.string(),
    signer_address: z.string(),
    deadline: millis,
    created_at: millis
  })
  .strict();

const legacySiteSchema = z
  .object({
    id: z.string().min(1).max(100),
    owner_profile_id: z.string(),
    slug: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    primary_package_hash: z.string().nullable(),
    primary_static_path: z.string().nullable(),
    created_at: millis,
    updated_at: millis,
    created_by_wallet: z.string(),
    updated_by_wallet: z.string().nullable()
  })
  .strict();

export const LEGACY_SIGNATURE_FORMS = [
  'personal_sign_payload_hash',
  'personal_sign_unsigned_hash',
  'personal_sign_unsigned_hash_null',
  'personal_sign_unsigned_unstored_hash',
  'personal_sign_unsigned_preimage',
  'personal_sign_unsigned_preimage_null',
  'personal_sign_unsigned_unstored_preimage'
] as const;
export type LegacySignatureForm = (typeof LEGACY_SIGNATURE_FORMS)[number];

const legacyPackageSchema = z
  .object({
    package_hash: z.string(),
    payload_hash: z.string(),
    schema: z.string(),
    site_id: z.string(),
    owner_profile_id: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    static_path: z.string(),
    canonical_url: z.string().nullable(),
    package_json: cid,
    storage_json: json,
    signature_json: json,
    published_at: millis,
    published_by_wallet: z.string(),
    signature_check: z
      .object({
        verified: z.boolean(),
        form: z.enum(LEGACY_SIGNATURE_FORMS).nullable(),
        signer: z.string().nullable()
      })
      .strict()
  })
  .strict();

const archiveSchema = z
  .object({
    schema: z.literal(PROFILE_CMS_ARCHIVE_SCHEMA),
    profile_id: z.string().min(1).max(100),
    profile_handle: z.string().nullable(),
    frozen_at: millis,
    packages: z.array(archivePackageSchema),
    pointer_events: z.array(archivePointerEventSchema),
    publish_signatures: z.array(archivePublishSignatureSchema),
    legacy: z
      .object({
        sites: z.array(legacySiteSchema),
        packages: z.array(legacyPackageSchema)
      })
      .strict()
  })
  .strict();

export type ProfileCmsArchive = z.infer<typeof archiveSchema>;
export type ProfileCmsArchivePackage = z.infer<typeof archivePackageSchema>;
export type ProfileCmsArchiveLegacyPackage = z.infer<
  typeof legacyPackageSchema
>;
export type ProfileCmsArchivePointerEvent = z.infer<
  typeof archivePointerEventSchema
>;

/** A pointer event row as 6529.io stores it. */
export function archivePointerEventToEntity(
  row: ProfileCmsArchivePointerEvent
): ProfileCmsPointerEventEntity {
  return {
    ...row,
    typed_data: row.typed_data ?? null,
    storage_receipt: row.storage_receipt ?? null
  };
}

export type ProfileCmsArchiveReadResult =
  | { readonly ok: true; readonly archive: ProfileCmsArchive }
  | { readonly ok: false; readonly reason: string };

/**
 * Why an archive's rows don't all belong to its profile, or null when they
 * do: every package, pointer event, publish signature, legacy site and legacy
 * package names the archive's profile, and every legacy package's site is in
 * the archive.
 */
export function archiveOwnershipProblem(
  archive: ProfileCmsArchive
): string | null {
  const profileId = archive.profile_id;
  if (archive.packages.some((row) => row.profile_id !== profileId)) {
    return 'package_of_another_profile';
  }
  if (archive.pointer_events.some((row) => row.profile_id !== profileId)) {
    return 'pointer_event_of_another_profile';
  }
  if (archive.publish_signatures.some((row) => row.profile_id !== profileId)) {
    return 'publish_signature_of_another_profile';
  }
  const packageIds = new Set(archive.packages.map((row) => row.id));
  if (
    archive.pointer_events.some((row) => !packageIds.has(row.package_db_id)) ||
    archive.publish_signatures.some((row) => !packageIds.has(row.package_db_id))
  ) {
    return 'history_of_a_package_not_in_the_archive';
  }
  if (
    archive.legacy.sites.some((site) => site.owner_profile_id !== profileId)
  ) {
    return 'legacy_site_of_another_profile';
  }
  const siteIds = new Set(archive.legacy.sites.map((site) => site.id));
  if (
    archive.legacy.packages.some(
      (row) => row.owner_profile_id !== profileId || !siteIds.has(row.site_id)
    )
  ) {
    return 'legacy_package_of_another_site';
  }
  return null;
}

/** The archive's bytes: canonical JSON, so equal content gives an equal CID. */
export function encodeProfileCmsArchive(archive: ProfileCmsArchive): Buffer {
  return Buffer.from(canonicalizeJson(archive), 'utf8');
}

export function readProfileCmsArchive(
  bytes: Buffer
): ProfileCmsArchiveReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'archive_not_json' };
  }
  const result = archiveSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: 'archive_schema_invalid' };
  }
  if (
    encodeProfileCmsArchive(result.data).toString('utf8') !==
    bytes.toString('utf8')
  ) {
    return { ok: false, reason: 'archive_not_canonical' };
  }
  return { ok: true, archive: result.data };
}

/** A package row as the API serves it: the content core with its envelope overlaid. */
export function archivePackageToEntity(
  row: ProfileCmsArchivePackage,
  core: Record<string, unknown>
): ProfileCmsPackageEntity {
  const {
    package: _packageCid,
    envelope,
    publication,
    publication_rebuilt: _rebuilt,
    ...columns
  } = row;
  return {
    ...columns,
    validation_result: columns.validation_result ?? null,
    storage_receipts: columns.storage_receipts ?? null,
    recovery_receipt: columns.recovery_receipt ?? null,
    cms_package: {
      ...core,
      integrity: envelope.integrity,
      signatures: envelope.signatures,
      storage: envelope.storage
    },
    publication_cid: publication
  };
}

export function legacyPackageToRow(
  row: ProfileCmsArchiveLegacyPackage,
  packageJson: Record<string, unknown>
): CmsPublishedPackageRow {
  const { signature_check: _check, package_json: _cid, ...columns } = row;
  return {
    ...columns,
    storage_json: columns.storage_json ?? null,
    signature_json: columns.signature_json ?? null,
    package_json: packageJson
  };
}

/** The envelope part of a stored package; the rest is its content core. */
export function splitPackageEnvelope(cmsPackage: CmsPackageV1): {
  readonly integrity: CmsPackageV1['integrity'];
  readonly signatures: CmsPackageV1['signatures'];
  readonly storage: CmsPackageV1['storage'];
} {
  return {
    integrity: cmsPackage.integrity,
    signatures: cmsPackage.signatures,
    storage: cmsPackage.storage
  };
}
