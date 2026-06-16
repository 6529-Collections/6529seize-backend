import { CMS_PUBLISHED_PACKAGES_TABLE, CMS_SITES_TABLE } from '@/constants';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export type CmsSiteRow = {
  readonly id: string;
  readonly owner_profile_id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string | null;
  readonly primary_package_hash: string | null;
  readonly primary_static_path: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly created_by_wallet: string;
  readonly updated_by_wallet: string | null;
};

export type CmsPublishedPackageRow = {
  readonly package_hash: string;
  readonly payload_hash: string;
  readonly schema: string;
  readonly site_id: string;
  readonly owner_profile_id: string;
  readonly title: string;
  readonly description: string | null;
  readonly static_path: string;
  readonly canonical_url: string | null;
  readonly package_json: Record<string, unknown>;
  readonly storage_json: unknown;
  readonly signature_json: unknown;
  readonly published_at: number;
  readonly published_by_wallet: string;
};

export type NewCmsSite = Pick<
  CmsSiteRow,
  | 'id'
  | 'owner_profile_id'
  | 'slug'
  | 'title'
  | 'description'
  | 'created_at'
  | 'updated_at'
  | 'created_by_wallet'
>;

export type CmsPublishedSiteRow = {
  readonly site: CmsSiteRow;
  readonly published_package: CmsPublishedPackageRow;
};

type JoinedPublishedSiteRow = Omit<CmsSiteRow, 'primary_package_hash'> & {
  readonly primary_package_hash: string;
  readonly package_payload_hash: string;
  readonly package_schema: string;
  readonly package_title: string;
  readonly package_description: string | null;
  readonly package_static_path: string;
  readonly package_canonical_url: string | null;
  readonly package_json: Record<string, unknown>;
  readonly package_storage_json: unknown;
  readonly package_signature_json: unknown;
  readonly package_published_at: number;
  readonly package_published_by_wallet: string;
};

function mapJoinedPublishedSiteRow(
  row: JoinedPublishedSiteRow
): CmsPublishedSiteRow {
  return {
    site: {
      id: row.id,
      owner_profile_id: row.owner_profile_id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      primary_package_hash: row.primary_package_hash,
      primary_static_path: row.primary_static_path,
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by_wallet: row.created_by_wallet,
      updated_by_wallet: row.updated_by_wallet
    },
    published_package: {
      package_hash: row.primary_package_hash,
      payload_hash: row.package_payload_hash,
      schema: row.package_schema,
      site_id: row.id,
      owner_profile_id: row.owner_profile_id,
      title: row.package_title,
      description: row.package_description,
      static_path: row.package_static_path,
      canonical_url: row.package_canonical_url,
      package_json: row.package_json,
      storage_json: row.package_storage_json,
      signature_json: row.package_signature_json,
      published_at: row.package_published_at,
      published_by_wallet: row.package_published_by_wallet
    }
  };
}

export class CmsDb extends LazyDbAccessCompatibleService {
  public async createSite(site: NewCmsSite): Promise<void> {
    await this.db.execute(
      `
        INSERT INTO ${CMS_SITES_TABLE}
          (id, owner_profile_id, slug, title, description, created_at, updated_at, created_by_wallet)
        VALUES
          (:id, :owner_profile_id, :slug, :title, :description, :created_at, :updated_at, :created_by_wallet)
      `,
      site
    );
  }

  public async findSiteById(siteId: string): Promise<CmsSiteRow | null> {
    return this.db.oneOrNull<CmsSiteRow>(
      `
        SELECT *
        FROM ${CMS_SITES_TABLE}
        WHERE id = :siteId
      `,
      { siteId }
    );
  }

  public async findSiteByOwnerAndSlug(
    ownerProfileId: string,
    slug: string
  ): Promise<CmsSiteRow | null> {
    return this.db.oneOrNull<CmsSiteRow>(
      `
        SELECT *
        FROM ${CMS_SITES_TABLE}
        WHERE owner_profile_id = :ownerProfileId
          AND slug = :slug
      `,
      { ownerProfileId, slug }
    );
  }

  public async findSitesByOwner(ownerProfileId: string): Promise<CmsSiteRow[]> {
    return this.db.execute<CmsSiteRow>(
      `
        SELECT *
        FROM ${CMS_SITES_TABLE}
        WHERE owner_profile_id = :ownerProfileId
        ORDER BY updated_at DESC, id ASC
      `,
      { ownerProfileId }
    );
  }

  public async findPublishedPackageByHash(
    packageHash: string
  ): Promise<CmsPublishedPackageRow | null> {
    return this.db.oneOrNull<CmsPublishedPackageRow>(
      `
        SELECT *
        FROM ${CMS_PUBLISHED_PACKAGES_TABLE}
        WHERE package_hash = :packageHash
      `,
      { packageHash }
    );
  }

  public async findPrimaryPublishedSiteByOwnerProfileId(
    ownerProfileId: string
  ): Promise<CmsPublishedSiteRow | null> {
    const row = await this.db.oneOrNull<JoinedPublishedSiteRow>(
      `
        SELECT
          s.*,
          p.payload_hash AS package_payload_hash,
          p.schema AS package_schema,
          p.title AS package_title,
          p.description AS package_description,
          p.static_path AS package_static_path,
          p.canonical_url AS package_canonical_url,
          p.package_json AS package_json,
          p.storage_json AS package_storage_json,
          p.signature_json AS package_signature_json,
          p.published_at AS package_published_at,
          p.published_by_wallet AS package_published_by_wallet
        FROM ${CMS_SITES_TABLE} s
        JOIN ${CMS_PUBLISHED_PACKAGES_TABLE} p
          ON p.package_hash = s.primary_package_hash
        WHERE s.owner_profile_id = :ownerProfileId
          AND s.primary_package_hash IS NOT NULL
        ORDER BY s.updated_at DESC, s.id ASC
        LIMIT 1
      `,
      { ownerProfileId }
    );
    return row ? mapJoinedPublishedSiteRow(row) : null;
  }

  public async publishPackage(
    cmsPackage: CmsPublishedPackageRow,
    setPrimary: boolean
  ): Promise<void> {
    await this.executeNativeQueriesInTransaction(async (connection) => {
      await this.db.execute(
        `
          INSERT INTO ${CMS_PUBLISHED_PACKAGES_TABLE}
            (
              package_hash,
              payload_hash,
              \`schema\`,
              site_id,
              owner_profile_id,
              title,
              description,
              static_path,
              canonical_url,
              package_json,
              storage_json,
              signature_json,
              published_at,
              published_by_wallet
            )
          VALUES
            (
              :package_hash,
              :payload_hash,
              :schema,
              :site_id,
              :owner_profile_id,
              :title,
              :description,
              :static_path,
              :canonical_url,
              :package_json,
              :storage_json,
              :signature_json,
              :published_at,
              :published_by_wallet
            )
          ON DUPLICATE KEY UPDATE package_hash = package_hash
        `,
        {
          ...cmsPackage,
          package_json: JSON.stringify(cmsPackage.package_json),
          storage_json: JSON.stringify(cmsPackage.storage_json),
          signature_json: JSON.stringify(cmsPackage.signature_json)
        },
        { wrappedConnection: connection }
      );

      if (!setPrimary) {
        return;
      }

      await this.db.execute(
        `
          UPDATE ${CMS_SITES_TABLE}
          SET primary_package_hash = :package_hash,
              primary_static_path = :static_path,
              updated_at = :published_at,
              updated_by_wallet = :published_by_wallet
          WHERE id = :site_id
            AND owner_profile_id = :owner_profile_id
        `,
        cmsPackage,
        { wrappedConnection: connection }
      );
    });
  }
}

export const cmsDb = new CmsDb(dbSupplier);
