import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import {
  ProfileCmsPackageEntity,
  ProfileCmsPackageStatus
} from '@/entities/IProfileCmsPackage';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import {
  NewProfileCmsPackageEntity,
  ProfileCmsPackagesDb,
  profileCmsPackagesDb
} from '@/profile-cms/profile-cms-packages.db';
import {
  cmsPackageSchema,
  CmsPackageV1,
  CmsValidationResultV1,
  validateCmsPackageV1
} from '@/profile-cms/protocol/v1';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';
import { randomUUID } from 'node:crypto';
import {
  identityFetcher,
  IdentityFetcher
} from '@/api/identities/identity.fetcher';

export interface SaveProfileCmsPackageDraftRequest {
  readonly profile_id: string;
  readonly cms_package: unknown;
}

export interface ValidateProfileCmsPackageRequest {
  readonly cms_package: unknown;
  readonly allow_fixture_signatures?: boolean;
  readonly allow_fixture_storage?: boolean;
  readonly enforce_hashes?: boolean;
}

export interface PublishProfileCmsPackageRequest {
  readonly expected_package_hash?: string;
  readonly expected_payload_hash?: string;
}

export interface ProfileCmsPackageResponse {
  readonly id: string;
  readonly package: unknown;
  readonly profile_id: string;
  readonly profile_handle: string;
  readonly package_id: string;
  readonly version: number;
  readonly status: string;
  readonly package_hash: string;
  readonly payload_hash: string;
  readonly updated_at: number;
  readonly created_at: number;
  readonly published_at?: number;
}

export interface ProfileCmsPrimaryPackageResponse {
  readonly package: unknown;
  readonly package_id: string;
  readonly version: number;
  readonly package_hash: string;
  readonly payload_hash: string;
  readonly updated_at: number;
  readonly published_at?: number;
}

interface ProfileHandleIdentity {
  readonly id: string;
  readonly handle: string;
}

export class ProfileCmsApiService {
  constructor(
    private readonly packagesDb: ProfileCmsPackagesDb,
    private readonly identityFetcher: IdentityFetcher
  ) {}

  async saveDraft(
    request: SaveProfileCmsPackageDraftRequest,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageResponse> {
    this.assertCanManageProfile(request.profile_id, ctx.authenticationContext);
    const cmsPackage = this.parsePackageOrThrow(request.cms_package);
    const profile = await this.getProfileIdentityOrThrow(request.profile_id);
    this.assertPackageProfileMatches(cmsPackage, profile);
    const createdByProfileId = this.getLoggedInProfileId(
      ctx.authenticationContext
    );

    const now = Time.currentMillis();
    const version = await this.packagesDb.getNextVersion(
      profile.id,
      cmsPackage.package_id,
      ctx
    );
    const receipt = this.getIndexedStorageReceipt(cmsPackage);
    const entity: NewProfileCmsPackageEntity = {
      id: randomUUID(),
      profile_id: profile.id,
      profile_handle: profile.handle,
      package_id: cmsPackage.package_id,
      version,
      status: ProfileCmsPackageStatus.DRAFT,
      cms_package: cmsPackage,
      payload_hash: cmsPackage.integrity.payload_hash,
      package_hash: cmsPackage.integrity.package_hash,
      primary_path: `/${cmsPackage.profile.handle}/index.html`,
      is_primary: false,
      created_by_profile_id: createdByProfileId,
      published_by_profile_id: null,
      created_at: now,
      updated_at: now,
      validated_at: null,
      published_at: null,
      failed_at: null,
      archived_at: null,
      superseded_by_id: null,
      validation_result: null,
      validation_error: null,
      storage_receipts: cmsPackage.storage,
      storage_provider: receipt?.provider ?? null,
      storage_uri: receipt?.uri ?? null,
      storage_content_hash: receipt?.content_hash ?? null,
      storage_provider_content_id: receipt?.provider_content_id ?? null,
      storage_recorded_at: receipt?.recorded_at ?? null,
      storage_pinned: receipt?.pinned ?? null,
      storage_canonical: receipt?.canonical ?? null
    };

    return this.toPackageResponse(await this.packagesDb.insert(entity, ctx));
  }

  validatePackage(
    request: ValidateProfileCmsPackageRequest
  ): CmsValidationResultV1 {
    return validateCmsPackageV1(request.cms_package, {
      allowFixtureSignatures: request.allow_fixture_signatures,
      allowFixtureStorage: request.allow_fixture_storage,
      enforceHashes: request.enforce_hashes
    });
  }

  async publish(
    id: string,
    request: PublishProfileCmsPackageRequest,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageResponse> {
    const entity = await this.getPackageEntityOrThrow(id, ctx);
    this.assertCanManageProfile(entity.profile_id, ctx.authenticationContext);
    this.assertDraftCanBePublished(entity);
    this.assertExpectedHashes(entity, request);

    const validatingAt = Time.currentMillis();
    await this.packagesDb.markValidating(entity.id, validatingAt, ctx);
    const validationResult = validateCmsPackageV1(entity.cms_package, {
      allowFixtureSignatures: false,
      allowFixtureStorage: false,
      enforceHashes: true
    });

    if (!validationResult.valid) {
      const failedAt = Time.currentMillis();
      await this.packagesDb.markFailed(
        entity.id,
        validationResult,
        this.getValidationErrorMessage(validationResult),
        failedAt,
        ctx
      );
      throw new BadRequestException('CMS package is not valid for publish');
    }

    const publishedAt = Time.currentMillis();
    const publishedByProfileId = this.getLoggedInProfileId(
      ctx.authenticationContext
    );
    await this.packagesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        await this.packagesDb.supersedePrimaryForProfile(
          entity.profile_id,
          entity.id,
          publishedAt,
          txCtx
        );
        await this.packagesDb.markPublished(
          entity.id,
          publishedByProfileId,
          validationResult,
          publishedAt,
          txCtx
        );
      }
    );

    return this.toPackageResponse(
      await this.getPackageEntityOrThrow(entity.id, ctx)
    );
  }

  async listForProfile(
    profileId: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageResponse[]> {
    const includePrivate = this.canManageProfile(
      profileId,
      ctx.authenticationContext
    );
    const packages = await this.packagesDb.listByProfile(
      profileId,
      includePrivate,
      ctx
    );
    return packages
      .filter((entity) => includePrivate || this.isPublicPackage(entity))
      .map((entity) => this.toPackageResponse(entity));
  }

  async getPrimaryByHandle(
    handle: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPrimaryPackageResponse> {
    const entity = await this.packagesDb.findPrimaryPublishedByHandle(
      handle,
      ctx
    );
    if (!entity || !this.isPublicPackage(entity)) {
      throw new NotFoundException(
        `Profile ${handle} has no primary published CMS package`
      );
    }
    return this.toPrimaryPackageResponse(entity);
  }

  async getById(
    id: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageResponse> {
    return this.toReadablePackageResponse(
      await this.getPackageEntityOrThrow(id, ctx),
      ctx
    );
  }

  async getByVersion(
    profileId: string,
    packageId: string,
    version: number,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageResponse> {
    const entity = await this.packagesDb.findByVersion(
      profileId,
      packageId,
      version,
      ctx
    );
    if (!entity) {
      throw new NotFoundException(
        `Profile CMS package ${packageId} v${version} was not found`
      );
    }
    return this.toReadablePackageResponse(entity, ctx);
  }

  async getByHash(
    packageHash: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageResponse> {
    const entities = await this.packagesDb.findByHash(packageHash, ctx);
    const publicEntity = entities.find((entity) =>
      this.isPublicPackage(entity)
    );
    if (publicEntity) {
      return this.toPackageResponse(publicEntity);
    }
    const privateEntity = entities.find((entity) =>
      this.canManageProfile(entity.profile_id, ctx.authenticationContext)
    );
    if (privateEntity) {
      return this.toPackageResponse(privateEntity);
    }
    throw new NotFoundException(
      `Profile CMS package ${packageHash} was not found`
    );
  }

  private toReadablePackageResponse(
    entity: ProfileCmsPackageEntity,
    ctx: RequestContext
  ): ProfileCmsPackageResponse {
    if (
      entity.status === ProfileCmsPackageStatus.PUBLISHED &&
      this.isPublicPackage(entity)
    ) {
      return this.toPackageResponse(entity);
    }

    if (!this.canManageProfile(entity.profile_id, ctx.authenticationContext)) {
      throw new NotFoundException(
        `Profile CMS package ${entity.id} was not found`
      );
    }
    return this.toPackageResponse(entity);
  }

  private async getPackageEntityOrThrow(
    id: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageEntity> {
    const entity = await this.packagesDb.findById(id, ctx);
    if (!entity) {
      throw new NotFoundException(`Profile CMS package ${id} was not found`);
    }
    return entity;
  }

  private parsePackageOrThrow(input: unknown): CmsPackageV1 {
    const parsed = cmsPackageSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException('CMS package does not match V1 schema');
    }
    return parsed.data;
  }

  private async getProfileIdentityOrThrow(
    profileId: string
  ): Promise<ProfileHandleIdentity> {
    const identity =
      await this.identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey: profileId },
        {}
      );
    if (!identity?.handle || !identity.id) {
      throw new NotFoundException(`Profile ${profileId} not found`);
    }
    return { id: identity.id, handle: identity.handle };
  }

  private assertPackageProfileMatches(
    cmsPackage: CmsPackageV1,
    profile: ProfileHandleIdentity
  ): void {
    if (
      cmsPackage.profile.profile_id &&
      cmsPackage.profile.profile_id !== profile.id
    ) {
      throw new BadRequestException(
        'CMS package profile_id does not match request'
      );
    }
    if (
      cmsPackage.profile.handle.toLowerCase() !== profile.handle.toLowerCase()
    ) {
      throw new BadRequestException(
        'CMS package handle does not match profile'
      );
    }
  }

  private assertCanManageProfile(
    profileId: string,
    authenticationContext: AuthenticationContext | undefined
  ): void {
    if (!this.canManageProfile(profileId, authenticationContext)) {
      throw new ForbiddenException(
        'You cannot manage CMS packages for this profile'
      );
    }
  }

  private getLoggedInProfileId(
    authenticationContext: AuthenticationContext | undefined
  ): string {
    const loggedInProfileId =
      authenticationContext?.getLoggedInUsersProfileId();
    if (!loggedInProfileId) {
      throw new ForbiddenException(
        'You cannot manage CMS packages for this profile'
      );
    }
    return loggedInProfileId;
  }

  private canManageProfile(
    profileId: string,
    authenticationContext: AuthenticationContext | undefined
  ): boolean {
    return (
      authenticationContext?.getActingAsId() === profileId &&
      authenticationContext.hasRightsTo(ProfileProxyActionType.PUBLISH_CMS)
    );
  }

  private assertExpectedHashes(
    entity: ProfileCmsPackageEntity,
    request: PublishProfileCmsPackageRequest
  ): void {
    if (
      request.expected_package_hash &&
      request.expected_package_hash !== entity.package_hash
    ) {
      throw new BadRequestException(
        'Expected package hash does not match draft'
      );
    }
    if (
      request.expected_payload_hash &&
      request.expected_payload_hash !== entity.payload_hash
    ) {
      throw new BadRequestException(
        'Expected payload hash does not match draft'
      );
    }
  }

  private assertDraftCanBePublished(entity: ProfileCmsPackageEntity): void {
    if (entity.status !== ProfileCmsPackageStatus.DRAFT) {
      throw new BadRequestException('Only draft CMS packages can be published');
    }
  }

  private getValidationErrorMessage(result: CmsValidationResultV1): string {
    return result.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.code)
      .sort((left, right) => left.localeCompare(right))
      .join(', ');
  }

  private isPublicPackage(entity: ProfileCmsPackageEntity): boolean {
    return (
      entity.status === ProfileCmsPackageStatus.PUBLISHED &&
      this.isProductionSafePackage(entity.cms_package)
    );
  }

  private isProductionSafePackage(input: unknown): boolean {
    const parsed = cmsPackageSchema.safeParse(input);
    if (!parsed.success) {
      return false;
    }
    return validateCmsPackageV1(parsed.data, {
      allowFixtureSignatures: false,
      allowFixtureStorage: false,
      enforceHashes: true
    }).valid;
  }

  private getIndexedStorageReceipt(
    cmsPackage: CmsPackageV1
  ): CmsPackageV1['storage'][number] | undefined {
    return (
      cmsPackage.storage.find((receipt) => receipt.canonical) ??
      cmsPackage.storage.find(
        (receipt) =>
          receipt.provider === 'ipfs' || receipt.provider === 'arweave'
      ) ??
      cmsPackage.storage[0]
    );
  }

  private toPackageResponse(
    entity: ProfileCmsPackageEntity
  ): ProfileCmsPackageResponse {
    return {
      id: entity.id,
      package: entity.cms_package,
      profile_id: entity.profile_id,
      profile_handle: entity.profile_handle,
      package_id: entity.package_id,
      version: entity.version,
      status: entity.status.toLowerCase(),
      package_hash: entity.package_hash,
      payload_hash: entity.payload_hash,
      updated_at: entity.updated_at,
      created_at: entity.created_at,
      ...(entity.published_at ? { published_at: entity.published_at } : {})
    };
  }

  private toPrimaryPackageResponse(
    entity: ProfileCmsPackageEntity
  ): ProfileCmsPrimaryPackageResponse {
    return {
      package: entity.cms_package,
      package_id: entity.package_id,
      version: entity.version,
      package_hash: entity.package_hash,
      payload_hash: entity.payload_hash,
      updated_at: entity.updated_at,
      ...(entity.published_at ? { published_at: entity.published_at } : {})
    };
  }
}

export const profileCmsApiService = new ProfileCmsApiService(
  profileCmsPackagesDb,
  identityFetcher
);
