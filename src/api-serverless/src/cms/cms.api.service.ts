import { AuthenticationContext } from '@/auth-context';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import { ids } from '@/ids';
import { Time } from '@/time';
import { ApiCmsCreateSiteRequest } from '@/api/generated/models/ApiCmsCreateSiteRequest';
import { ApiCmsPublishedPackage } from '@/api/generated/models/ApiCmsPublishedPackage';
import { ApiCmsPublishedSite } from '@/api/generated/models/ApiCmsPublishedSite';
import { ApiCmsPublishPackageRequest } from '@/api/generated/models/ApiCmsPublishPackageRequest';
import { ApiCmsSite } from '@/api/generated/models/ApiCmsSite';
import { ApiCmsStorageLocation } from '@/api/generated/models/ApiCmsStorageLocation';
import { ApiCmsSignatureEnvelope } from '@/api/generated/models/ApiCmsSignatureEnvelope';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { RequestContext } from '@/request.context';
import {
  cmsDb,
  CmsPublishedPackageRow,
  CmsPublishedSiteRow,
  CmsSiteRow
} from './cms.db';

type CmsServiceContext = RequestContext & {
  readonly authenticationContext: AuthenticationContext;
};

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

function requireAuthenticatedProfileId(ctx: CmsServiceContext): string {
  const profileId = ctx.authenticationContext.authenticatedProfileId;
  if (!profileId) {
    throw new ForbiddenException('Please create a profile first.');
  }
  return profileId;
}

function requireAuthenticatedWallet(ctx: CmsServiceContext): string {
  const wallet = ctx.authenticationContext.authenticatedWallet;
  if (!wallet) {
    throw new ForbiddenException('Authentication wallet not found.');
  }
  return wallet;
}

function assertHash(value: string, fieldName: string): void {
  if (!HASH_PATTERN.test(value)) {
    throw new BadRequestException(`${fieldName} must be a sha256 hash.`);
  }
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function mapSite(row: CmsSiteRow): ApiCmsSite {
  return {
    id: row.id,
    owner_profile_id: row.owner_profile_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    primary_package_hash: row.primary_package_hash,
    primary_static_path: row.primary_static_path,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function mapPublishedPackage(
  row: CmsPublishedPackageRow
): ApiCmsPublishedPackage {
  return {
    package_hash: row.package_hash,
    payload_hash: row.payload_hash,
    schema: row.schema,
    site_id: row.site_id,
    owner_profile_id: row.owner_profile_id,
    title: row.title,
    description: row.description,
    static_path: row.static_path,
    canonical_url: row.canonical_url,
    package_json: row.package_json as Record<string, unknown>,
    storage: row.storage_json as ApiCmsStorageLocation[],
    signature: row.signature_json as ApiCmsSignatureEnvelope,
    published_at: row.published_at,
    published_by_wallet: row.published_by_wallet
  };
}

function mapPublishedSite(row: CmsPublishedSiteRow): ApiCmsPublishedSite {
  return {
    site: mapSite(row.site),
    published_package: mapPublishedPackage(row.published_package)
  };
}

export class CmsApiService {
  public async createSite(
    request: ApiCmsCreateSiteRequest,
    ctx: CmsServiceContext
  ): Promise<ApiCmsSite> {
    const ownerProfileId = requireAuthenticatedProfileId(ctx);
    const wallet = requireAuthenticatedWallet(ctx);
    const slug = normalizeSlug(request.slug);
    const existing = await cmsDb.findSiteByOwnerAndSlug(ownerProfileId, slug);
    if (existing) {
      throw new BadRequestException('CMS site slug already exists.');
    }
    const now = Time.currentMillis();
    const site = {
      id: ids.uniqueShortId(),
      owner_profile_id: ownerProfileId,
      slug,
      title: request.title.trim(),
      description: request.description ?? null,
      created_at: now,
      updated_at: now,
      created_by_wallet: wallet
    };
    await cmsDb.createSite(site);
    return mapSite({
      ...site,
      primary_package_hash: null,
      primary_static_path: null,
      updated_by_wallet: null
    });
  }

  public async listMySites(ctx: CmsServiceContext): Promise<ApiCmsSite[]> {
    const ownerProfileId = requireAuthenticatedProfileId(ctx);
    return cmsDb
      .findSitesByOwner(ownerProfileId)
      .then((sites) => sites.map((site) => mapSite(site)));
  }

  public async getPrimarySiteByIdentity(
    identity: string,
    ctx: RequestContext
  ): Promise<ApiCmsPublishedSite> {
    const ownerProfileId =
      await identityFetcher.getProfileIdByIdentityKeyOrThrow(
        { identityKey: identity },
        ctx
      );
    const site =
      await cmsDb.findPrimaryPublishedSiteByOwnerProfileId(ownerProfileId);
    if (!site) {
      throw new NotFoundException('CMS site not found.');
    }
    return mapPublishedSite(site);
  }

  public async getPackageByHash(
    packageHash: string
  ): Promise<ApiCmsPublishedPackage> {
    assertHash(packageHash, 'package_hash');
    const cmsPackage = await cmsDb.findPublishedPackageByHash(packageHash);
    if (!cmsPackage) {
      throw new NotFoundException('CMS package not found.');
    }
    return mapPublishedPackage(cmsPackage);
  }

  public async publishPackage(
    siteId: string,
    request: ApiCmsPublishPackageRequest,
    ctx: CmsServiceContext
  ): Promise<ApiCmsPublishedSite> {
    assertHash(request.package_hash, 'package_hash');
    assertHash(request.payload_hash, 'payload_hash');
    const ownerProfileId = requireAuthenticatedProfileId(ctx);
    const wallet = requireAuthenticatedWallet(ctx);
    const site = await cmsDb.findSiteById(siteId);
    if (!site) {
      throw new NotFoundException('CMS site not found.');
    }
    if (site.owner_profile_id !== ownerProfileId) {
      throw new ForbiddenException('You can only publish your own CMS sites.');
    }
    const existingPackage = await cmsDb.findPublishedPackageByHash(
      request.package_hash
    );
    if (existingPackage && existingPackage.site_id !== siteId) {
      throw new BadRequestException(
        'CMS package hash already belongs to a different site.'
      );
    }
    const publishedAt = Time.currentMillis();
    await cmsDb.publishPackage(
      {
        package_hash: request.package_hash,
        payload_hash: request.payload_hash,
        schema: request.schema,
        site_id: siteId,
        owner_profile_id: ownerProfileId,
        title: request.title.trim(),
        description: request.description ?? null,
        static_path: request.static_path,
        canonical_url: request.canonical_url ?? null,
        package_json: request.package_json,
        storage_json: request.storage,
        signature_json: request.signature,
        published_at: publishedAt,
        published_by_wallet: wallet
      },
      request.set_primary ?? true
    );
    const primarySite =
      await cmsDb.findPrimaryPublishedSiteByOwnerProfileId(ownerProfileId);
    if (!primarySite) {
      throw new NotFoundException('CMS site not found.');
    }
    return mapPublishedSite(primarySite);
  }
}

export const cmsApiService = new CmsApiService();
