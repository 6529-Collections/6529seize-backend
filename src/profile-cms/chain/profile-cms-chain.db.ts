import {
  CMS_PUBLISHED_PACKAGES_TABLE,
  CMS_SITES_TABLE,
  PROFILE_CMS_CHAIN_HEADS_TABLE,
  PROFILE_CMS_PACKAGES_TABLE,
  PROFILE_CMS_POINTER_EVENTS_TABLE,
  PROFILE_CMS_PUBLISH_SIGNATURES_TABLE,
  PROFILES_TABLE
} from '@/constants';
import { CmsPublishedPackageRow, CmsSiteRow } from '@/api/cms/cms.db';
import { ProfileCmsChainHeadEntity } from '@/entities/IProfileCmsChainHead';
import {
  ProfileCmsPackageEntity,
  ProfileCmsPackageStatus
} from '@/entities/IProfileCmsPackage';
import { ProfileCmsPointerEventEntity } from '@/entities/IProfileCmsPointerEvent';
import { ProfileCmsPublishSignatureEntity } from '@/entities/IProfileCmsPublishSignature';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

const PACKAGE_COLUMNS = [
  'id',
  'profile_id',
  'profile_handle',
  'package_id',
  'version',
  'status',
  'cms_package',
  'payload_hash',
  'package_hash',
  'primary_path',
  'is_primary',
  'production_valid',
  'created_by_profile_id',
  'published_by_profile_id',
  'created_at',
  'updated_at',
  'validated_at',
  'published_at',
  'failed_at',
  'archived_at',
  'superseded_by_id',
  'validation_result',
  'validation_error',
  'storage_receipts',
  'storage_provider',
  'storage_uri',
  'storage_content_hash',
  'storage_provider_content_id',
  'storage_recorded_at',
  'storage_pinned',
  'storage_canonical',
  'recovery_receipt',
  'publication_cid'
] as const;

const EVENT_COLUMNS = [
  'id',
  'event_type',
  'profile_id',
  'profile_handle',
  'package_db_id',
  'package_id',
  'package_version',
  'package_hash',
  'payload_hash',
  'previous_package_db_id',
  'actor_profile_id',
  'signer_address',
  'signature',
  'typed_data',
  'typed_data_hash',
  'storage_receipt',
  'event_sequence',
  'created_at',
  'chain_height',
  'doc_cid'
] as const;

const SIGNATURE_COLUMNS = [
  'id',
  'typed_data_hash',
  'profile_id',
  'package_db_id',
  'package_id',
  'package_version',
  'package_hash',
  'signer_address',
  'deadline',
  'created_at'
] as const;

const SITE_COLUMNS = [
  'id',
  'owner_profile_id',
  'slug',
  'title',
  'description',
  'primary_package_hash',
  'primary_static_path',
  'created_at',
  'updated_at',
  'created_by_wallet',
  'updated_by_wallet'
] as const;

const LEGACY_PACKAGE_COLUMNS = [
  'package_hash',
  'payload_hash',
  'schema',
  'site_id',
  'owner_profile_id',
  'title',
  'description',
  'static_path',
  'canonical_url',
  'package_json',
  'storage_json',
  'signature_json',
  'published_at',
  'published_by_wallet'
] as const;

/** Reads and writes of the profile site index that follow the chain. */
export class ProfileCmsChainDb extends LazyDbAccessCompatibleService {
  /** With `lock`, holds the row to the end of ctx.connection's transaction. */
  async findHead(
    principal: string,
    ctx: RequestContext,
    lock = false
  ): Promise<ProfileCmsChainHeadEntity | null> {
    const rows = await this.run<ProfileCmsChainHeadEntity>(
      `select * from ${PROFILE_CMS_CHAIN_HEADS_TABLE} where principal = :principal${lock ? ' for update' : ''}`,
      { principal },
      ctx
    );
    return rows[0] ? hydrateHead(rows[0]) : null;
  }

  /** Moves a principal's head forward to an applied version; never back. */
  async advanceHead(
    head: Pick<
      ProfileCmsChainHeadEntity,
      | 'principal'
      | 'profile_id'
      | 'doc_version'
      | 'doc_cid'
      | 'height'
      | 'archive_cid'
      | 'updated_at'
    >,
    ctx: RequestContext
  ): Promise<void> {
    const params = { ...head };
    await this.run(
      `insert ignore into ${PROFILE_CMS_CHAIN_HEADS_TABLE}
         (principal, profile_id, doc_version, doc_cid, height, archive_cid, updated_at, pending_attempts)
       values
         (:principal, :profile_id, :doc_version, :doc_cid, :height, :archive_cid, :updated_at, 0)`,
      params,
      ctx
    );
    await this.run(
      `update ${PROFILE_CMS_CHAIN_HEADS_TABLE}
       set profile_id = :profile_id,
           doc_version = :doc_version,
           doc_cid = :doc_cid,
           height = :height,
           archive_cid = :archive_cid,
           updated_at = :updated_at,
           pending_version = null,
           pending_height = null,
           pending_attempts = 0,
           pending_reason = null
       where principal = :principal and doc_version < :doc_version`,
      params,
      ctx
    );
  }

  /** Records a version that could not be applied yet, and how often it was tried. */
  async recordPending(
    pending: {
      readonly principal: string;
      readonly profile_id: string;
      readonly version: number;
      readonly height: number;
      readonly attempts: number;
      readonly reason: string;
    },
    ctx: RequestContext
  ): Promise<void> {
    const params = { ...pending, reason: pending.reason.slice(0, 200) };
    await this.run(
      `insert ignore into ${PROFILE_CMS_CHAIN_HEADS_TABLE}
         (principal, profile_id, doc_version, doc_cid, height, archive_cid, updated_at,
          pending_version, pending_height, pending_attempts, pending_reason)
       values
         (:principal, :profile_id, 0, null, 0, null, 0,
          :version, :height, :attempts, :reason)`,
      params,
      ctx
    );
    await this.run(
      `update ${PROFILE_CMS_CHAIN_HEADS_TABLE}
       set pending_version = :version,
           pending_height = :height,
           pending_attempts = :attempts,
           pending_reason = :reason
       where principal = :principal and doc_version < :version`,
      params,
      ctx
    );
  }

  /**
   * Where to follow the change feed from: the lowest change still pending,
   * else one past the highest applied, else `fromHeight`.
   */
  async cursorHeight(fromHeight: number, ctx: RequestContext): Promise<number> {
    const rows = await this.run<{
      pending: number | string | null;
      applied: number | string | null;
    }>(
      `select min(pending_height) as pending, max(height) as applied
       from ${PROFILE_CMS_CHAIN_HEADS_TABLE}`,
      {},
      ctx
    );
    const pending = rows[0]?.pending;
    if (pending !== null && pending !== undefined) {
      return Number(pending);
    }
    const applied = rows[0]?.applied;
    return applied !== null && applied !== undefined && Number(applied) > 0
      ? Math.max(Number(applied) + 1, fromHeight)
      : fromHeight;
  }

  /** Locks the profile row when the mirror has it, so API writes on the same profile wait. */
  async lockProfile(profileId: string, ctx: RequestContext): Promise<void> {
    await this.run(
      `select external_id from ${PROFILES_TABLE} where external_id = :profileId for update`,
      { profileId },
      ctx
    );
  }

  async findPrimary(
    profileId: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageEntity | null> {
    const rows = await this.run<ProfileCmsPackageEntity>(
      `select * from ${PROFILE_CMS_PACKAGES_TABLE}
       where profile_id = :profileId
         and status = '${ProfileCmsPackageStatus.PUBLISHED}'
         and is_primary = true
       order by published_at desc, updated_at desc
       limit 1
       for update`,
      { profileId },
      ctx
    );
    return rows[0] ? hydratePackage(rows[0]) : null;
  }

  async findPackageById(
    id: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageEntity | null> {
    const rows = await this.run<ProfileCmsPackageEntity>(
      `select * from ${PROFILE_CMS_PACKAGES_TABLE} where id = :id for update`,
      { id },
      ctx
    );
    return rows[0] ? hydratePackage(rows[0]) : null;
  }

  /** Whether the profile's index holds this publication as published. */
  async isPublishedPublication(
    publicationCid: string,
    profileId: string,
    ctx: RequestContext
  ): Promise<boolean> {
    const rows = await this.run<{ id: string }>(
      `select id from ${PROFILE_CMS_PACKAGES_TABLE}
       where publication_cid = :publicationCid
         and profile_id = :profileId
         and published_at is not null
       limit 1`,
      { publicationCid, profileId },
      ctx
    );
    return rows.length > 0;
  }

  async upsertPackage(
    row: ProfileCmsPackageEntity,
    ctx: RequestContext
  ): Promise<void> {
    await this.run(
      upsertSql(PROFILE_CMS_PACKAGES_TABLE, PACKAGE_COLUMNS, 'update'),
      packageParams(row),
      ctx
    );
  }

  /** Archive import: a row already present keeps its values, except an empty publication CID. */
  async insertPackageIfMissing(
    row: ProfileCmsPackageEntity,
    ctx: RequestContext
  ): Promise<void> {
    await this.run(
      upsertSql(PROFILE_CMS_PACKAGES_TABLE, PACKAGE_COLUMNS, 'keep'),
      packageParams(row),
      ctx
    );
    await this.run(
      `update ${PROFILE_CMS_PACKAGES_TABLE}
       set publication_cid = :publication_cid
       where id = :id
         and profile_id = :profile_id
         and publication_cid is null
         and :publication_cid is not null`,
      {
        id: row.id,
        profile_id: row.profile_id,
        publication_cid: row.publication_cid ?? null
      },
      ctx
    );
  }

  async insertEventIfMissing(
    event: ProfileCmsPointerEventEntity,
    ctx: RequestContext
  ): Promise<void> {
    await this.run(
      upsertSql(PROFILE_CMS_POINTER_EVENTS_TABLE, EVENT_COLUMNS, 'keep'),
      {
        ...event,
        typed_data: jsonOrNull(event.typed_data),
        storage_receipt: jsonOrNull(event.storage_receipt),
        chain_height: event.chain_height ?? null,
        doc_cid: event.doc_cid ?? null
      },
      ctx
    );
  }

  async insertSignatureIfMissing(
    signature: ProfileCmsPublishSignatureEntity,
    ctx: RequestContext
  ): Promise<void> {
    // typed_data_hash is unique: a signature consumed before the switch keeps its row.
    await this.run(
      `insert ignore into ${PROFILE_CMS_PUBLISH_SIGNATURES_TABLE}
         (${SIGNATURE_COLUMNS.join(', ')})
       values (${SIGNATURE_COLUMNS.map((column) => `:${column}`).join(', ')})`,
      { ...signature },
      ctx
    );
  }

  /**
   * Legacy CMS rows are frozen at the identity freeze, so an owner's rows are
   * replaced as a whole by what their archive file says. A site or package
   * of another owner, or whose key another owner holds, is left alone.
   */
  async replaceLegacyForOwner(
    ownerProfileId: string,
    allSites: readonly CmsSiteRow[],
    allPackages: readonly CmsPublishedPackageRow[],
    ctx: RequestContext
  ): Promise<{ readonly skipped: number }> {
    const sites = allSites.filter(
      (site) => site.owner_profile_id === ownerProfileId
    );
    const packages = allPackages.filter(
      (legacyPackage) => legacyPackage.owner_profile_id === ownerProfileId
    );
    const takenSites = await this.keysOfOtherOwners(
      CMS_SITES_TABLE,
      'id',
      sites.map((site) => site.id),
      ownerProfileId,
      ctx
    );
    const takenPackages = await this.keysOfOtherOwners(
      CMS_PUBLISHED_PACKAGES_TABLE,
      'package_hash',
      packages.map((legacyPackage) => legacyPackage.package_hash),
      ownerProfileId,
      ctx
    );
    await this.run(
      `delete from ${CMS_PUBLISHED_PACKAGES_TABLE} where owner_profile_id = :ownerProfileId`,
      { ownerProfileId },
      ctx
    );
    await this.run(
      `delete from ${CMS_SITES_TABLE} where owner_profile_id = :ownerProfileId`,
      { ownerProfileId },
      ctx
    );
    let skipped =
      allSites.length - sites.length + allPackages.length - packages.length;
    for (const site of sites) {
      if (takenSites.has(site.id)) {
        skipped++;
        continue;
      }
      await this.run(
        upsertSql(CMS_SITES_TABLE, SITE_COLUMNS, 'update'),
        { ...site },
        ctx
      );
    }
    for (const legacyPackage of packages) {
      if (takenPackages.has(legacyPackage.package_hash)) {
        skipped++;
        continue;
      }
      await this.run(
        upsertSql(
          CMS_PUBLISHED_PACKAGES_TABLE,
          LEGACY_PACKAGE_COLUMNS,
          'update'
        ),
        {
          ...legacyPackage,
          package_json: JSON.stringify(legacyPackage.package_json),
          storage_json: JSON.stringify(legacyPackage.storage_json),
          signature_json: JSON.stringify(legacyPackage.signature_json)
        },
        ctx
      );
    }
    return { skipped };
  }

  private async keysOfOtherOwners(
    table: string,
    key: string,
    values: readonly string[],
    ownerProfileId: string,
    ctx: RequestContext
  ): Promise<Set<string>> {
    if (values.length === 0) {
      return new Set();
    }
    const rows = await this.run<{ k: string }>(
      `select ${key} as k from ${table}
       where ${key} in (:values) and owner_profile_id <> :ownerProfileId`,
      { values, ownerProfileId },
      ctx
    );
    return new Set(rows.map((row) => row.k));
  }

  private async run<T = unknown>(
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<T[]> {
    return this.db.execute<T>(
      sql,
      params,
      ctx.connection ? { wrappedConnection: ctx.connection } : undefined
    );
  }
}

function upsertSql(
  table: string,
  columns: readonly string[],
  onDuplicate: 'update' | 'keep'
): string {
  const names = columns.map((column) => `\`${column}\``).join(', ');
  const values = columns.map((column) => `:${column}`).join(', ');
  const [key] = columns;
  const updates =
    onDuplicate === 'update'
      ? columns
          .slice(1)
          .map((column) => `\`${column}\` = values(\`${column}\`)`)
          .join(', ')
      : `\`${key}\` = \`${key}\``;
  return `insert into ${table} (${names}) values (${values}) on duplicate key update ${updates}`;
}

function packageParams(row: ProfileCmsPackageEntity): Record<string, unknown> {
  return {
    ...row,
    cms_package: JSON.stringify(row.cms_package),
    validation_result: jsonOrNull(row.validation_result),
    storage_receipts: JSON.stringify(row.storage_receipts),
    recovery_receipt: jsonOrNull(row.recovery_receipt),
    is_primary: row.is_primary ? 1 : 0,
    production_valid: row.production_valid ? 1 : 0,
    storage_pinned: nullableBooleanParam(row.storage_pinned),
    storage_canonical: nullableBooleanParam(row.storage_canonical),
    validated_at: row.validated_at ?? null,
    published_at: row.published_at ?? null,
    failed_at: row.failed_at ?? null,
    archived_at: row.archived_at ?? null,
    publication_cid: row.publication_cid ?? null
  };
}

function hydrateHead(
  row: ProfileCmsChainHeadEntity
): ProfileCmsChainHeadEntity {
  return {
    ...row,
    doc_version: Number(row.doc_version),
    height: Number(row.height),
    updated_at: Number(row.updated_at),
    pending_version:
      row.pending_version === null || row.pending_version === undefined
        ? null
        : Number(row.pending_version),
    pending_height:
      row.pending_height === null || row.pending_height === undefined
        ? null
        : Number(row.pending_height),
    pending_attempts: Number(row.pending_attempts ?? 0)
  };
}

function hydratePackage(row: ProfileCmsPackageEntity): ProfileCmsPackageEntity {
  return {
    ...row,
    cms_package: parseJsonColumn(row.cms_package),
    validation_result: parseJsonColumn(row.validation_result),
    storage_receipts: parseJsonColumn(row.storage_receipts),
    recovery_receipt: parseJsonColumn(row.recovery_receipt),
    is_primary: !!row.is_primary,
    production_valid: !!row.production_valid,
    storage_pinned: nullableBoolean(row.storage_pinned),
    storage_canonical: nullableBoolean(row.storage_canonical),
    publication_cid: row.publication_cid ?? null
  };
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function nullableBoolean(value: unknown): boolean | null {
  return value === null || value === undefined ? null : !!value;
}

function nullableBooleanParam(
  value: boolean | null | undefined
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value ? 1 : 0;
}

export const profileCmsChainDb = new ProfileCmsChainDb(dbSupplier);
