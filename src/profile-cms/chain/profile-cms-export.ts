import { createHash } from 'node:crypto';
import { TypedDataEncoder, verifyTypedData } from 'ethers';
import {
  CMS_PUBLISHED_PACKAGES_TABLE,
  CMS_SITES_TABLE,
  IDENTITIES_TABLE,
  PROFILE_CMS_PACKAGES_TABLE,
  PROFILE_CMS_POINTER_EVENTS_TABLE,
  PROFILE_CMS_PUBLISH_SIGNATURES_TABLE
} from '@/constants';
import { CmsPublishedPackageRow, CmsSiteRow } from '@/api/cms/cms.db';
import {
  ProfileCmsPackageEntity,
  ProfileCmsPackageStatus
} from '@/entities/IProfileCmsPackage';
import {
  ProfileCmsPointerEventEntity,
  ProfileCmsPointerEventType
} from '@/entities/IProfileCmsPointerEvent';
import { ProfileCmsPublishSignatureEntity } from '@/entities/IProfileCmsPublishSignature';
import {
  encodeProfileCmsArchive,
  PROFILE_CMS_ARCHIVE_SCHEMA,
  ProfileCmsArchive,
  ProfileCmsArchiveLegacyPackage,
  ProfileCmsArchivePackage
} from '@/profile-cms/chain/profile-cms-archive';
import { cmsCidFromBytes } from '@/profile-cms/chain/profile-cms-cid';
import { pinnedEip1271Verifier } from '@/profile-cms/chain/profile-cms-eip1271-pinned';
import { checkLegacyCmsSignature } from '@/profile-cms/chain/profile-cms-legacy-signature';
import { checkProfileCmsPublication } from '@/profile-cms/chain/profile-cms-publication-check';
import { ProfileDocCms } from '@/profile-cms/chain/profile-doc-cms';
import { buildProfileCmsPublicationManifest } from '@/profile-cms/profile-cms-publication';
import {
  Eip1271SignatureVerifier,
  ProfileCmsPublishTypedData
} from '@/profile-cms/profile-cms-signing';
import {
  canonicalizeJson,
  CmsPackageV1,
  cmsPackageSchema,
  toPackageHashInput
} from '@/profile-cms/protocol/v1';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * A profile's value in cms-fields.json, in the shape the identity snapshot
 * builder reads (build.rs `add_cms`): `{ primary?: { publication, package },
 * archive? }`. The builder writes it into the ProfileDoc as the three keys
 * `cms.primary.publication`, `cms.primary.package` and `cms.archive`.
 */
export function snapshotCmsValue(cms: ProfileDocCms): Record<string, unknown> {
  return {
    ...(cms.primary
      ? {
          primary: {
            publication: cms.primary.publication,
            package: cms.primary.package
          }
        }
      : {}),
    ...(cms.archive ? { archive: cms.archive } : {})
  };
}

/** One profile's part of the import: its profile site keys and the files they name. */
export interface ProfileCmsExportEntry {
  readonly profile_id: string;
  /** The profile's handle at the freeze. */
  readonly handle: string | null;
  /** The site and archive the imported ProfileDoc names; null when the profile has nothing to carry. */
  readonly cms: ProfileDocCms | null;
  readonly files: readonly { readonly cid: string; readonly bytes: Buffer }[];
  readonly report: ProfileCmsExportReport;
}

export interface ProfileCmsExportReport {
  readonly packages: number;
  readonly rebuilt_publications: readonly string[];
  /**
   * Rebuilt records the reader's check refuses at their publish (a Safe at
   * that block), with the reason. They stay in the history file. Whether a
   * primary is carried depends only on the check at T (`primary_refused`).
   */
  readonly rebuilt_refused: readonly {
    readonly id: string;
    readonly reason: string;
  }[];
  /** Packages whose stored publication record could not be fetched: the export must not be used. */
  readonly publication_unavailable: readonly string[];
  readonly without_publication: readonly string[];
  readonly bad_core: readonly string[];
  readonly primary: string | null;
  /** The package hash of the primary the API serves at T, carried or not. */
  readonly primary_package_hash: string | null;
  readonly primary_handle: string | null;
  readonly primary_carried: boolean;
  /**
   * Why the reader's check refuses the primary at the freeze (T), as the
   * index will judge it at the switch; the primary is then not carried.
   */
  readonly primary_refused: string | null;
  /** Why the same check refuses it at its publishing, if it does (reported only). */
  readonly primary_refused_at_publish: string | null;
  readonly legacy_packages: number;
  readonly legacy_unverified: readonly string[];
  readonly legacy_unverified_primaries: readonly string[];
}

export interface ProfileCmsExportSource {
  readonly handle: string | null;
  readonly wallets: readonly string[];
  readonly packages: readonly ProfileCmsPackageEntity[];
  readonly events: readonly ProfileCmsPointerEventEntity[];
  readonly signatures: readonly ProfileCmsPublishSignatureEntity[];
  readonly legacySites: readonly CmsSiteRow[];
  readonly legacyPackages: readonly CmsPublishedPackageRow[];
}

/** Fetches a stored publication record by its receipt and checks its hash; null when unavailable. */
export type ProfileCmsPublicationFetcher = (receipt: {
  readonly uri: string;
  readonly content_hash: string;
}) => Promise<Buffer | null>;

interface PackageFiles {
  readonly row: ProfileCmsArchivePackage;
  readonly files: { cid: string; bytes: Buffer }[];
  readonly publicationUnavailable: boolean;
}

/**
 * Builds the import's profile site part at the identity freeze: for each
 * profile, the archive file of its public site history and the site and
 * archive its imported ProfileDoc names. Reads only; the team runs it on a read
 * replica at T.
 */
export class ProfileCmsExporter {
  constructor(
    private readonly fetchPublication: ProfileCmsPublicationFetcher,
    private readonly safeVerifierAt: (
      timeMs: number
    ) => Eip1271SignatureVerifier = pinnedEip1271Verifier
  ) {}

  async exportProfile(
    profileId: string,
    source: ProfileCmsExportSource,
    frozenAt: number
  ): Promise<ProfileCmsExportEntry> {
    const files = new Map<string, Buffer>();
    const rebuilt: string[] = [];
    const rebuiltRefused: { id: string; reason: string }[] = [];
    const unavailable: string[] = [];
    const withoutPublication: string[] = [];
    const badCore: string[] = [];
    const archivePackages: ProfileCmsArchivePackage[] = [];
    const published = source.packages
      .filter((row) => row.published_at !== null)
      .sort(compareRows);
    for (const row of published) {
      const exported = await this.exportPackage(row, source.events);
      if (!exported) {
        badCore.push(row.id);
        continue;
      }
      exported.files.forEach(({ cid, bytes }) => files.set(cid, bytes));
      if (exported.publicationUnavailable) unavailable.push(row.id);
      else if (!exported.row.publication) withoutPublication.push(row.id);
      if (exported.row.publication_rebuilt) {
        rebuilt.push(row.id);
        const reason = await this.checkPublication(
          profileId,
          exported.row,
          files,
          source,
          exported.row.published_at
        );
        if (reason) rebuiltRefused.push({ id: row.id, reason });
      }
      archivePackages.push(exported.row);
    }
    const kept = new Set(archivePackages.map((row) => row.id));
    const legacy = this.exportLegacy(source);
    legacy.files.forEach(({ cid, bytes }) => files.set(cid, bytes));
    const archive: ProfileCmsArchive = {
      schema: PROFILE_CMS_ARCHIVE_SCHEMA,
      profile_id: profileId,
      profile_handle: source.handle,
      frozen_at: frozenAt,
      packages: archivePackages,
      pointer_events: source.events
        .filter((event) => kept.has(event.package_db_id))
        .sort(compareEvents)
        .map(toArchiveEvent),
      publish_signatures: source.signatures
        .filter((signature) => kept.has(signature.package_db_id))
        .sort((left, right) => compareBytewise(left.id, right.id))
        .map((signature) => ({ ...signature })),
      legacy: { sites: legacy.sites, packages: legacy.packages }
    };
    // The row the API serves: published, primary, production valid, the
    // latest published first.
    const primary = archivePackages
      .filter(
        (row) =>
          row.is_primary &&
          row.status === ProfileCmsPackageStatus.PUBLISHED &&
          row.production_valid
      )
      .sort(
        (left, right) =>
          right.published_at - left.published_at ||
          right.updated_at - left.updated_at
      )[0];
    // Checked at T as the index checks it at the switch (a Safe's owners may
    // have changed since the publish), and at the publish for the report.
    const primaryRefused = primary
      ? await this.checkPublication(profileId, primary, files, source, frozenAt)
      : null;
    const primaryRefusedAtPublish = primary
      ? await this.checkPublication(
          profileId,
          primary,
          files,
          source,
          primary.published_at
        )
      : null;
    const hasHistory = archivePackages.length > 0 || legacy.sites.length > 0;
    let archiveCid: string | null = null;
    if (hasHistory) {
      const bytes = encodeProfileCmsArchive(archive);
      if (bytes.length > MAX_FILE_BYTES) {
        throw new Error(
          `Profile ${profileId}: archive is ${bytes.length} bytes`
        );
      }
      archiveCid = cmsCidFromBytes(bytes);
      files.set(archiveCid, bytes);
    }
    const primaryPointer =
      primary?.publication && primaryRefused === null
        ? { publication: primary.publication, package: primary.package }
        : null;
    return {
      profile_id: profileId,
      handle: source.handle,
      cms:
        primaryPointer || archiveCid
          ? { primary: primaryPointer, archive: archiveCid }
          : null,
      files: Array.from(files.entries())
        .sort(([left], [right]) => compareBytewise(left, right))
        .map(([cid, bytes]) => ({ cid, bytes })),
      report: {
        packages: archivePackages.length,
        rebuilt_publications: rebuilt,
        rebuilt_refused: rebuiltRefused,
        publication_unavailable: unavailable,
        without_publication: withoutPublication,
        bad_core: badCore,
        primary: primary?.id ?? null,
        primary_package_hash: primary?.package_hash ?? null,
        primary_handle: primary?.profile_handle ?? null,
        primary_carried: primaryPointer !== null,
        primary_refused: primaryRefused,
        primary_refused_at_publish: primaryRefusedAtPublish,
        legacy_packages: legacy.packages.length,
        legacy_unverified: legacy.unverified,
        legacy_unverified_primaries: legacy.unverifiedPrimaries
      }
    };
  }

  private async exportPackage(
    row: ProfileCmsPackageEntity,
    events: readonly ProfileCmsPointerEventEntity[]
  ): Promise<PackageFiles | null> {
    const parsed = cmsPackageSchema.safeParse(row.cms_package);
    if (!parsed.success) {
      return null;
    }
    const cmsPackage = parsed.data;
    const coreBytes = Buffer.from(
      canonicalizeJson(toPackageHashInput(cmsPackage)),
      'utf8'
    );
    if (sha256Hash(coreBytes) !== row.package_hash) {
      return null;
    }
    const files: { cid: string; bytes: Buffer }[] = [
      { cid: cmsCidFromBytes(coreBytes), bytes: coreBytes }
    ];
    const publication = await this.publicationFor(row, cmsPackage, events);
    const stored = publication && 'cid' in publication ? publication : null;
    if (stored) {
      files.push({ cid: stored.cid, bytes: stored.bytes });
    }
    const {
      cms_package: _cmsPackage,
      publication_cid: _publicationCid,
      ...columns
    } = row;
    return {
      row: {
        ...columns,
        published_at: row.published_at as number,
        validation_result: row.validation_result ?? null,
        storage_receipts: row.storage_receipts ?? null,
        recovery_receipt: row.recovery_receipt ?? null,
        package: files[0].cid,
        envelope: {
          integrity: cmsPackage.integrity,
          signatures: cmsPackage.signatures,
          storage: cmsPackage.storage
        },
        publication: stored?.cid ?? null,
        publication_rebuilt: stored?.rebuilt ?? false
      },
      files,
      publicationUnavailable: publication !== null && !stored
    };
  }

  /**
   * Runs the reader's check on a package's publication record, as the index
   * runs it: files, bindings, the signature (a Safe at the Ethereum block
   * before `atMs`), CMS V1 production validation. Returns why it fails, or
   * null.
   */
  private async checkPublication(
    profileId: string,
    primary: ProfileCmsArchivePackage,
    files: ReadonlyMap<string, Buffer>,
    source: ProfileCmsExportSource,
    atMs: number
  ): Promise<string | null> {
    if (!primary.publication) {
      return 'no_publication_record';
    }
    const check = await checkProfileCmsPublication(
      {
        primary: { publication: primary.publication, package: primary.package },
        publicationBytes: files.get(primary.publication) ?? null,
        packageBytes: files.get(primary.package) ?? null,
        profileId,
        wallets: source.wallets.map((wallet) => wallet.toLowerCase()),
        signerAccepted: true,
        checkedAtMs: atMs
      },
      this.safeVerifierAt(atMs)
    );
    return check.ok ? null : check.reason;
  }

  /**
   * The stored publication record, fetched by its receipt; for a package
   * published before records existed, one rebuilt from the publish event's
   * signature. A stored record that can't be fetched is reported, never
   * replaced by a rebuilt one, so two runs give the same bytes.
   */
  private async publicationFor(
    row: ProfileCmsPackageEntity,
    cmsPackage: CmsPackageV1,
    events: readonly ProfileCmsPointerEventEntity[]
  ): Promise<
    | { cid: string; bytes: Buffer; rebuilt: boolean }
    | { unavailable: true }
    | null
  > {
    const receipt = readReceipt(row.recovery_receipt);
    if (receipt) {
      const bytes = await this.fetchPublication(receipt);
      if (bytes && sha256Hash(bytes) === receipt.content_hash) {
        return { cid: cmsCidFromBytes(bytes), bytes, rebuilt: false };
      }
      return { unavailable: true };
    }
    const event = events.find(
      (candidate) =>
        candidate.package_db_id === row.id &&
        candidate.event_type === ProfileCmsPointerEventType.PUBLISH &&
        candidate.signature &&
        candidate.signer_address &&
        candidate.typed_data
    );
    if (!event) {
      return null;
    }
    const manifest = rebuildPublication(row, cmsPackage, event);
    if (!manifest) {
      return null;
    }
    const bytes = Buffer.from(canonicalizeJson(manifest), 'utf8');
    return { cid: cmsCidFromBytes(bytes), bytes, rebuilt: true };
  }

  private exportLegacy(source: ProfileCmsExportSource): {
    sites: CmsSiteRow[];
    packages: ProfileCmsArchiveLegacyPackage[];
    files: { cid: string; bytes: Buffer }[];
    unverified: string[];
    unverifiedPrimaries: string[];
  } {
    const files: { cid: string; bytes: Buffer }[] = [];
    const unverified: string[] = [];
    const packages = [...source.legacyPackages]
      .sort((left, right) =>
        compareBytewise(left.package_hash, right.package_hash)
      )
      .map((legacyPackage): ProfileCmsArchiveLegacyPackage => {
        const bytes = Buffer.from(
          canonicalizeJson(legacyPackage.package_json),
          'utf8'
        );
        const cid = cmsCidFromBytes(bytes);
        files.push({ cid, bytes });
        const signatureCheck = checkLegacyCmsSignature({
          payloadHash: legacyPackage.payload_hash,
          packageJson: legacyPackage.package_json,
          signatureJson: legacyPackage.signature_json,
          ownerWallets: source.wallets
        });
        if (!signatureCheck.verified)
          unverified.push(legacyPackage.package_hash);
        return {
          ...legacyPackage,
          storage_json: legacyPackage.storage_json ?? null,
          signature_json: legacyPackage.signature_json ?? null,
          package_json: cid,
          signature_check: { ...signatureCheck }
        };
      });
    const siteIds = new Set(
      packages.map((legacyPackage) => legacyPackage.site_id)
    );
    const sites = source.legacySites
      .filter((site) => siteIds.has(site.id))
      .sort((left, right) => compareBytewise(left.id, right.id))
      .map((site) => ({ ...site }));
    const unverifiedSet = new Set(unverified);
    return {
      sites,
      packages,
      files,
      unverified,
      unverifiedPrimaries: sites
        .filter(
          (site) =>
            site.primary_package_hash &&
            unverifiedSet.has(site.primary_package_hash)
        )
        .map((site) => site.id)
    };
  }
}

function rebuildPublication(
  row: ProfileCmsPackageEntity,
  cmsPackage: CmsPackageV1,
  event: ProfileCmsPointerEventEntity
): unknown {
  const typedData = event.typed_data as ProfileCmsPublishTypedData;
  const signature = event.signature as string;
  const signer = event.signer_address as string;
  let isEoa = false;
  try {
    isEoa =
      verifyTypedData(
        typedData.domain,
        typedData.types,
        typedData.message,
        signature
      ).toLowerCase() === signer.toLowerCase();
  } catch {
    isEoa = false;
  }
  const chainId = Number(typedData.domain.chainId);
  return buildProfileCmsPublicationManifest({
    entity: row,
    cmsPackage,
    request: {
      signer_address: signer,
      signature,
      chain_id: chainId,
      deadline: Number(typedData.message.deadline),
      is_safe_signature: !isEoa,
      verifying_contract:
        (typedData.domain.verifyingContract as string | undefined) ?? null
    },
    verification: {
      valid: true,
      signer_address: signer,
      typed_data: typedData,
      typed_data_hash:
        event.typed_data_hash ??
        TypedDataEncoder.hash(
          typedData.domain,
          typedData.types,
          typedData.message
        )
    },
    publishedAt: row.published_at as number
  });
}

function readReceipt(
  value: unknown
): { uri: string; content_hash: string } | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { uri, content_hash: contentHash } = value as Record<string, unknown>;
  return typeof uri === 'string' && typeof contentHash === 'string'
    ? { uri, content_hash: contentHash }
    : null;
}

function toArchiveEvent(event: ProfileCmsPointerEventEntity) {
  const { chain_height: _height, doc_cid: _doc, ...columns } = event;
  return {
    ...columns,
    typed_data: event.typed_data ?? null,
    storage_receipt: event.storage_receipt ?? null
  };
}

/** Compares by UTF-16 code units, which is bytewise for the ASCII ids and hashes here. */
function compareBytewise(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function sha256Hash(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function compareRows(
  left: ProfileCmsPackageEntity,
  right: ProfileCmsPackageEntity
): number {
  return left.version - right.version || compareBytewise(left.id, right.id);
}

function compareEvents(
  left: ProfileCmsPointerEventEntity,
  right: ProfileCmsPointerEventEntity
): number {
  return (
    left.created_at - right.created_at ||
    left.event_sequence - right.event_sequence ||
    compareBytewise(left.id, right.id)
  );
}

/** Reads one profile's rows for the export. */
export class ProfileCmsExportDb extends LazyDbAccessCompatibleService {
  async listProfileIds(): Promise<string[]> {
    const rows = await this.db.execute<{ profile_id: string }>(
      `select distinct profile_id from ${PROFILE_CMS_PACKAGES_TABLE} where published_at is not null
       union
       select distinct owner_profile_id as profile_id from ${CMS_PUBLISHED_PACKAGES_TABLE}
       order by profile_id`
    );
    return rows.map((row) => row.profile_id);
  }

  async loadSource(profileId: string): Promise<ProfileCmsExportSource> {
    const identity = await this.db.oneOrNull<{
      handle: string | null;
      consolidation_key: string;
    }>(
      `select handle, consolidation_key from ${IDENTITIES_TABLE} where profile_id = :profileId`,
      { profileId }
    );
    const packages = await this.db.execute<ProfileCmsPackageEntity>(
      `select * from ${PROFILE_CMS_PACKAGES_TABLE}
       where profile_id = :profileId and published_at is not null`,
      { profileId }
    );
    const ids = packages.map((row) => row.id);
    const events = ids.length
      ? await this.db.execute<ProfileCmsPointerEventEntity>(
          `select * from ${PROFILE_CMS_POINTER_EVENTS_TABLE} where package_db_id in (:ids)`,
          { ids }
        )
      : [];
    const signatures = ids.length
      ? await this.db.execute<ProfileCmsPublishSignatureEntity>(
          `select * from ${PROFILE_CMS_PUBLISH_SIGNATURES_TABLE} where package_db_id in (:ids)`,
          { ids }
        )
      : [];
    const legacySites = await this.db.execute<CmsSiteRow>(
      `select * from ${CMS_SITES_TABLE} where owner_profile_id = :profileId`,
      { profileId }
    );
    const legacyPackages = await this.db.execute<CmsPublishedPackageRow>(
      `select * from ${CMS_PUBLISHED_PACKAGES_TABLE} where owner_profile_id = :profileId`,
      { profileId }
    );
    return {
      handle: identity?.handle ?? null,
      wallets: identity ? identity.consolidation_key.split('-') : [],
      packages: packages.map(hydratePackageRow),
      events: events.map(hydrateEventRow),
      signatures: signatures.map((row) => ({
        ...row,
        package_version: Number(row.package_version),
        deadline: Number(row.deadline),
        created_at: Number(row.created_at)
      })),
      legacySites: legacySites.map((site) => ({
        ...site,
        created_at: Number(site.created_at),
        updated_at: Number(site.updated_at)
      })),
      legacyPackages: legacyPackages.map((legacyPackage) => ({
        ...legacyPackage,
        package_json: parseJson(legacyPackage.package_json) as Record<
          string,
          unknown
        >,
        storage_json: parseJson(legacyPackage.storage_json),
        signature_json: parseJson(legacyPackage.signature_json),
        published_at: Number(legacyPackage.published_at)
      }))
    };
  }
}

function hydratePackageRow(
  row: ProfileCmsPackageEntity
): ProfileCmsPackageEntity {
  return {
    ...row,
    version: Number(row.version),
    cms_package: parseJson(row.cms_package),
    validation_result: parseJson(row.validation_result),
    storage_receipts: parseJson(row.storage_receipts),
    recovery_receipt: parseJson(row.recovery_receipt),
    is_primary: !!row.is_primary,
    production_valid: !!row.production_valid,
    storage_pinned: row.storage_pinned === null ? null : !!row.storage_pinned,
    storage_canonical:
      row.storage_canonical === null ? null : !!row.storage_canonical,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    validated_at: nullableNumber(row.validated_at),
    published_at: nullableNumber(row.published_at),
    failed_at: nullableNumber(row.failed_at),
    archived_at: nullableNumber(row.archived_at),
    publication_cid: row.publication_cid ?? null
  };
}

function hydrateEventRow(
  row: ProfileCmsPointerEventEntity
): ProfileCmsPointerEventEntity {
  return {
    ...row,
    package_version: Number(row.package_version),
    event_sequence: Number(row.event_sequence),
    created_at: Number(row.created_at),
    typed_data: parseJson(row.typed_data),
    storage_receipt: parseJson(row.storage_receipt),
    chain_height: nullableNumber(row.chain_height ?? null),
    doc_cid: row.doc_cid ?? null
  };
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value ?? null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export const profileCmsExportDb = new ProfileCmsExportDb(dbSupplier);
