import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import {
  ProfileCmsPackageEntity,
  ProfileCmsPackageStatus
} from '@/entities/IProfileCmsPackage';
import {
  ProfileCmsPointerEventEntity,
  ProfileCmsPointerEventType
} from '@/entities/IProfileCmsPointerEvent';
import {
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import {
  NewProfileCmsPackageEntity,
  ProfileCmsPackagesDb,
  profileCmsPackagesDb
} from '@/profile-cms/profile-cms-packages.db';
import {
  ProfileCmsAgentPatchValidationResult,
  ValidateProfileCmsAgentPatchRequest,
  validateProfileCmsAgentPatch
} from '@/profile-cms/profile-cms-agent-patch';
import {
  ProfileCmsAgentSchemaBundleResponse,
  ProfileCmsAgentSourcePacketResponse,
  buildProfileCmsAgentSchemaBundle,
  buildProfileCmsAgentSourcePacket
} from '@/profile-cms/profile-cms-agent-source-packet';
import {
  ProfileCmsPointerEventsDb,
  profileCmsPointerEventsDb
} from '@/profile-cms/profile-cms-pointer-events.db';
import {
  ProfileCmsPublishSignaturesDb,
  profileCmsPublishSignaturesDb
} from '@/profile-cms/profile-cms-publish-signatures.db';
import {
  ProfileCmsPublishSignatureRequest,
  ProfileCmsPublishSignatureVerificationResult,
  verifyProfileCmsPublishSignature
} from '@/profile-cms/profile-cms-signing';
import {
  ProfileCmsStorageReceiptVerifier,
  profileCmsStorageReceiptVerifier
} from '@/profile-cms/profile-cms-storage';
import {
  canonicalizeJson,
  cmsPackageSchema,
  CmsPackageV1,
  CmsSignatureEnvelopeV1,
  CmsStorageReceiptV1,
  CmsValidationResultV1,
  computeCmsPackageHash,
  toPackageHashInput,
  validateCmsPackageV1
} from '@/profile-cms/protocol/v1';
import { RequestContext } from '@/request.context';
import { Time } from '@/time';
import { randomUUID } from 'node:crypto';
import {
  identityFetcher,
  IdentityFetcher
} from '@/api/identities/identity.fetcher';
import { ArweaveFileUploader, arweaveFileUploader } from '@/arweave';
import { Logger } from '@/logging';

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
  readonly signer_address: string;
  readonly signature: string;
  readonly chain_id: number;
  readonly deadline: number;
  readonly is_safe_signature?: boolean;
  readonly verifying_contract?: string | null;
}

export interface RollbackProfileCmsPackageRequest {
  readonly expected_current_package_id: string;
  readonly expected_current_package_hash?: string;
}

export interface ArchiveProfileCmsPackageRequest {
  readonly expected_package_hash?: string;
}

export interface ProfileCmsPackageStorageUploadResponse {
  readonly receipt: CmsStorageReceiptV1;
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

export interface ProfileCmsPointerEventResponse {
  readonly id: string;
  readonly event_type: string;
  readonly profile_id: string;
  readonly profile_handle: string;
  readonly package_id: string;
  readonly package_db_id: string;
  readonly package_version: number;
  readonly package_hash: string;
  readonly payload_hash: string;
  readonly previous_package_db_id?: string;
  readonly actor_profile_id: string;
  readonly signer_address?: string;
  readonly typed_data_hash?: string;
  readonly storage_receipt?: unknown;
  readonly event_sequence: number;
  readonly created_at: number;
}

export interface ProfileCmsPackageExportResponse {
  readonly package: unknown;
  readonly package_id: string;
  readonly package_db_id: string;
  readonly version: number;
  readonly status: string;
  readonly profile_id: string;
  readonly profile_handle: string;
  readonly primary_path: string;
  readonly package_hash: string;
  readonly payload_hash: string;
  readonly storage_receipts: unknown;
  readonly pointer_events: ProfileCmsPointerEventResponse[];
  readonly updated_at: number;
  readonly published_at?: number;
}

interface ProfileHandleIdentity {
  readonly id: string;
  readonly handle: string;
  readonly wallets: ReadonlySet<string>;
}

const PROFILE_CMS_PUBLISH_MAX_DEADLINE_MS = 15 * 60 * 1000;

const logger = Logger.get('ProfileCmsApiService');

export class ProfileCmsApiService {
  constructor(
    private readonly packagesDb: ProfileCmsPackagesDb,
    private readonly identityFetcher: IdentityFetcher,
    private readonly pointerEventsDb: ProfileCmsPointerEventsDb,
    private readonly publishSignaturesDb: ProfileCmsPublishSignaturesDb,
    private readonly storageReceiptVerifier: ProfileCmsStorageReceiptVerifier,
    private readonly publishSignatureVerifier = verifyProfileCmsPublishSignature,
    private readonly arweaveUploader: ArweaveFileUploader = arweaveFileUploader
  ) {}

  async saveDraft(
    request: SaveProfileCmsPackageDraftRequest,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageResponse> {
    this.assertCanManageProfile(request.profile_id, ctx.authenticationContext);
    const cmsPackage = this.parsePackageOrThrow(request.cms_package);
    const profile = await this.getProfileIdentityOrThrow(
      request.profile_id,
      ctx
    );
    this.assertPackageProfileMatches(cmsPackage, profile);
    this.assertPackageWalletsMatch(cmsPackage, profile);
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
      primary_path: `/${profile.handle}/index.html`,
      is_primary: false,
      production_valid: false,
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

  getAgentSchemaBundle(): ProfileCmsAgentSchemaBundleResponse {
    return buildProfileCmsAgentSchemaBundle(this.getCurrentIsoDate());
  }

  async getAgentSourcePacket(
    id: string,
    ctx: RequestContext
  ): Promise<ProfileCmsAgentSourcePacketResponse> {
    const entity = await this.getReadablePackageEntityOrThrow(id, ctx);
    const cmsPackage = this.parsePackageOrThrow(entity.cms_package);
    const checkedAt = this.getCurrentIsoDate();
    const liveValidation = validateCmsPackageV1(cmsPackage, {
      allowFixtureSignatures: false,
      allowFixtureStorage: false,
      checkedAt,
      enforceHashes: true
    });

    return buildProfileCmsAgentSourcePacket({
      entity,
      cmsPackage,
      liveValidation,
      generatedAt: checkedAt,
      visibility: this.isPublicPackage(entity)
        ? 'public_published'
        : 'private_authority_required'
    });
  }

  async validateAgentPatch(
    id: string,
    request: ValidateProfileCmsAgentPatchRequest,
    ctx: RequestContext
  ): Promise<ProfileCmsAgentPatchValidationResult> {
    const entity = await this.getPackageEntityOrThrow(id, ctx);
    this.assertCanManageProfile(entity.profile_id, ctx.authenticationContext);
    return validateProfileCmsAgentPatch({
      cmsPackage: this.parsePackageOrThrow(entity.cms_package),
      packageDbId: entity.id,
      packageId: entity.package_id,
      version: entity.version,
      packageHash: entity.package_hash,
      status: entity.status,
      request,
      checkedAt: this.getCurrentIsoDate()
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
    this.assertPublishSignatureRequest(request);
    this.assertPublishDeadline(request.deadline);

    // Verify the EIP-712 request signature FIRST. It derives everything from
    // the entity + request (via the client-signed canonical storage receipt)
    // and does not depend on the validity of the stored package's fixture
    // placeholders.
    const storedPackage = this.parsePackageOrThrow(entity.cms_package);
    const signedCanonicalReceipt =
      this.getSignedCanonicalReceiptOrThrow(storedPackage);

    const profile = await this.getProfileIdentityOrThrow(
      entity.profile_id,
      ctx
    );
    const signatureVerification = await this.publishSignatureVerifier({
      request,
      message: {
        action: 'publish',
        profileId: entity.profile_id,
        handle: profile.handle,
        packageId: entity.package_id,
        version: entity.version,
        draftId: entity.id,
        payloadHash: entity.payload_hash,
        packageHash: entity.package_hash,
        primaryPath: entity.primary_path,
        storageProvider: signedCanonicalReceipt.provider,
        storageUri: signedCanonicalReceipt.uri,
        storageContentHash: signedCanonicalReceipt.content_hash,
        deadline: request.deadline
      }
    });
    this.assertPublishSignatureVerified(signatureVerification);
    this.assertSignerWalletMatchesProfile(
      signatureVerification.signer_address,
      profile
    );

    // Rebuild the package the server will serve: discard client-provided
    // fixture signatures/storage and replace them with the real, server-
    // verified signature envelope and the real decentralized storage
    // receipt(s). The hash preimage (toPackageHashInput) strips signatures and
    // storage, so package_hash MUST remain unchanged.
    const rebuiltPackage = this.buildRebuiltPublishPackage(
      storedPackage,
      signatureVerification,
      request
    );
    if (computeCmsPackageHash(rebuiltPackage) !== entity.package_hash) {
      await this.markPublishFailed(
        entity.id,
        this.buildPublishFailureValidation(entity),
        'rebuilt_package_hash_mismatch',
        ctx
      );
      throw new BadRequestException(
        'Rebuilt CMS package hash does not match the stored draft'
      );
    }

    // Run production validation against the REBUILT package (never the stored
    // draft that still carries fixture placeholders).
    const validationResult = validateCmsPackageV1(rebuiltPackage, {
      allowFixtureSignatures: false,
      allowFixtureStorage: false,
      enforceHashes: true
    });
    if (!validationResult.valid) {
      await this.markPublishFailed(
        entity.id,
        validationResult,
        this.getValidationErrorMessage(validationResult),
        ctx
      );
      throw new BadRequestException('CMS package is not valid for publish');
    }

    const rebuiltStorageValidation =
      this.storageReceiptVerifier.validateForPublish(rebuiltPackage);
    if (
      !rebuiltStorageValidation.valid ||
      !rebuiltStorageValidation.canonical_receipt
    ) {
      await this.markPublishFailed(
        entity.id,
        validationResult,
        rebuiltStorageValidation.reason ?? 'storage_receipt_invalid',
        ctx
      );
      throw new BadRequestException(
        `CMS package storage receipt is not valid for publish: ${
          rebuiltStorageValidation.reason ?? 'unknown'
        }`
      );
    }
    const rebuiltCanonicalReceipt = rebuiltStorageValidation.canonical_receipt;

    const publishedAt = Time.currentMillis();
    const publishedByProfileId = this.getLoggedInProfileId(
      ctx.authenticationContext
    );
    await this.packagesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        await this.packagesDb.lockProfilePackagesForUpdate(
          entity.profile_id,
          txCtx
        );
        const lockedEntity = await this.packagesDb.findByIdForUpdate(
          entity.id,
          txCtx
        );
        if (!lockedEntity) {
          throw new NotFoundException(
            `Profile CMS package ${entity.id} was not found`
          );
        }
        this.assertDraftCanBePublished(lockedEntity);
        this.assertExpectedHashes(lockedEntity, request);
        await this.consumePublishSignatureOrThrow(
          lockedEntity,
          request,
          signatureVerification,
          txCtx
        );
        const previousPrimary =
          await this.packagesDb.findPrimaryPublishedByProfileIdForUpdate(
            lockedEntity.profile_id,
            txCtx
          );
        await this.packagesDb.markValidating(
          lockedEntity.id,
          publishedAt,
          txCtx
        );
        // Persist the rebuilt package (real signature envelope + real storage)
        // so the served primary package carries decentralized verifiability.
        await this.persistRebuiltPublishPackage(
          lockedEntity.id,
          rebuiltPackage,
          rebuiltCanonicalReceipt,
          publishedAt,
          txCtx
        );
        await this.packagesDb.supersedePrimaryForProfile(
          lockedEntity.profile_id,
          lockedEntity.id,
          publishedAt,
          txCtx
        );
        await this.packagesDb.markPublished(
          lockedEntity.id,
          publishedByProfileId,
          validationResult,
          publishedAt,
          txCtx
        );
        await this.recordPointerEvents(
          [
            this.toPointerEvent({
              eventType: ProfileCmsPointerEventType.PUBLISH,
              entity: lockedEntity,
              previousPackageDbId: previousPrimary?.id ?? null,
              actorProfileId: publishedByProfileId,
              signatureVerification,
              signatureRequest: request,
              storageReceipt: rebuiltCanonicalReceipt,
              createdAt: publishedAt
            }),
            ...(previousPrimary
              ? [
                  this.toPointerEvent({
                    eventType: ProfileCmsPointerEventType.SUPERSEDE,
                    entity: previousPrimary,
                    previousPackageDbId: lockedEntity.id,
                    actorProfileId: publishedByProfileId,
                    signatureVerification,
                    signatureRequest: request,
                    storageReceipt: rebuiltCanonicalReceipt,
                    createdAt: publishedAt
                  })
                ]
              : []),
            this.toPointerEvent({
              eventType: ProfileCmsPointerEventType.SET_PRIMARY,
              entity: lockedEntity,
              previousPackageDbId: previousPrimary?.id ?? null,
              actorProfileId: publishedByProfileId,
              signatureVerification,
              signatureRequest: request,
              storageReceipt: rebuiltCanonicalReceipt,
              createdAt: publishedAt
            })
          ],
          txCtx
        );
      }
    );

    return this.toPackageResponse(
      await this.getPackageEntityOrThrow(entity.id, ctx)
    );
  }

  async rollbackPrimary(
    id: string,
    request: RollbackProfileCmsPackageRequest,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageResponse> {
    const target = await this.getPackageEntityOrThrow(id, ctx);
    this.assertCanManageProfile(target.profile_id, ctx.authenticationContext);
    this.assertPackageCanBecomePrimary(target);
    const actorProfileId = this.getLoggedInProfileId(ctx.authenticationContext);
    const now = Time.currentMillis();

    await this.packagesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        await this.packagesDb.lockProfilePackagesForUpdate(
          target.profile_id,
          txCtx
        );
        const lockedTarget = await this.packagesDb.findByIdForUpdate(
          target.id,
          txCtx
        );
        if (!lockedTarget) {
          throw new NotFoundException(
            `Profile CMS package ${target.id} was not found`
          );
        }
        this.assertPackageCanBecomePrimary(lockedTarget);
        const currentPrimary =
          await this.packagesDb.findPrimaryPublishedByProfileIdForUpdate(
            lockedTarget.profile_id,
            txCtx
          );
        this.assertExpectedCurrentPrimary(currentPrimary, request);
        if (currentPrimary?.id === lockedTarget.id) {
          throw new BadRequestException(
            'Target CMS package is already primary'
          );
        }
        await this.packagesDb.supersedePrimaryForProfile(
          lockedTarget.profile_id,
          lockedTarget.id,
          now,
          txCtx
        );
        await this.packagesDb.markPrimary(lockedTarget.id, now, txCtx);
        await this.recordPointerEvents(
          [
            this.toPointerEvent({
              eventType: ProfileCmsPointerEventType.ROLLBACK,
              entity: lockedTarget,
              previousPackageDbId: currentPrimary?.id ?? null,
              actorProfileId,
              createdAt: now
            }),
            ...(currentPrimary
              ? [
                  this.toPointerEvent({
                    eventType: ProfileCmsPointerEventType.SUPERSEDE,
                    entity: currentPrimary,
                    previousPackageDbId: lockedTarget.id,
                    actorProfileId,
                    createdAt: now
                  })
                ]
              : []),
            this.toPointerEvent({
              eventType: ProfileCmsPointerEventType.SET_PRIMARY,
              entity: lockedTarget,
              previousPackageDbId: currentPrimary?.id ?? null,
              actorProfileId,
              createdAt: now
            })
          ],
          txCtx
        );
      }
    );

    return this.toPackageResponse(
      await this.getPackageEntityOrThrow(target.id, ctx)
    );
  }

  async archivePackage(
    id: string,
    request: ArchiveProfileCmsPackageRequest,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageResponse> {
    const entity = await this.getPackageEntityOrThrow(id, ctx);
    this.assertCanManageProfile(entity.profile_id, ctx.authenticationContext);
    this.assertExpectedPackageHash(entity, request.expected_package_hash);
    if (entity.is_primary) {
      throw new BadRequestException(
        'Primary CMS package must be rolled back before archive'
      );
    }
    if (entity.status === ProfileCmsPackageStatus.ARCHIVED) {
      throw new BadRequestException('CMS package is already archived');
    }
    const archivedAt = Time.currentMillis();
    const actorProfileId = this.getLoggedInProfileId(ctx.authenticationContext);
    await this.packagesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        const lockedEntity = await this.packagesDb.findByIdForUpdate(
          entity.id,
          txCtx
        );
        if (!lockedEntity) {
          throw new NotFoundException(
            `Profile CMS package ${entity.id} was not found`
          );
        }
        this.assertExpectedPackageHash(
          lockedEntity,
          request.expected_package_hash
        );
        if (lockedEntity.is_primary) {
          throw new BadRequestException(
            'Primary CMS package must be rolled back before archive'
          );
        }
        await this.packagesDb.archive(lockedEntity.id, archivedAt, txCtx);
        await this.recordPointerEvents(
          [
            this.toPointerEvent({
              eventType: ProfileCmsPointerEventType.ARCHIVE,
              entity: lockedEntity,
              previousPackageDbId: null,
              actorProfileId,
              createdAt: archivedAt
            })
          ],
          txCtx
        );
      }
    );
    return this.toPackageResponse(await this.getPackageEntityOrThrow(id, ctx));
  }

  async uploadToStorage(
    id: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageStorageUploadResponse> {
    const entity = await this.getPackageEntityOrThrow(id, ctx);
    this.assertCanManageProfile(entity.profile_id, ctx.authenticationContext);
    this.assertDraftCanBePublished(entity);

    const cmsPackage = this.parsePackageOrThrow(entity.cms_package);
    this.assertStoredPackageHashMatches(cmsPackage, entity);

    const existingReceipt = this.findCanonicalArweaveReceipt(
      cmsPackage,
      entity.package_hash
    );
    if (existingReceipt) {
      return { receipt: existingReceipt };
    }

    const canonicalBytes = Buffer.from(
      canonicalizeJson(toPackageHashInput(cmsPackage)),
      'utf8'
    );
    const transactionId =
      await this.uploadCanonicalJsonToArweave(canonicalBytes);

    const receipt: CmsStorageReceiptV1 = {
      provider: 'arweave',
      uri: `ar://${transactionId}`,
      content_hash: entity.package_hash,
      provider_content_id: transactionId,
      canonical: true,
      recorded_at: this.getCurrentIsoDate()
    };

    return this.packagesDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const txCtx: RequestContext = { ...ctx, connection };
        const lockedEntity = await this.packagesDb.findByIdForUpdate(
          entity.id,
          txCtx
        );
        if (!lockedEntity) {
          throw new NotFoundException(
            `Profile CMS package ${entity.id} was not found`
          );
        }
        this.assertDraftCanBePublished(lockedEntity);
        const lockedPackage = this.parsePackageOrThrow(
          lockedEntity.cms_package
        );
        this.assertStoredPackageHashMatches(lockedPackage, lockedEntity);
        if (lockedEntity.package_hash !== entity.package_hash) {
          throw new BadRequestException(
            'CMS package hash does not match the stored draft; refusing to upload'
          );
        }
        const concurrentReceipt = this.findCanonicalArweaveReceipt(
          lockedPackage,
          lockedEntity.package_hash
        );
        if (concurrentReceipt) {
          return { receipt: concurrentReceipt };
        }
        await this.persistStorageReceipt(
          lockedEntity,
          lockedPackage,
          receipt,
          txCtx
        );
        return { receipt };
      }
    );
  }

  private assertStoredPackageHashMatches(
    cmsPackage: CmsPackageV1,
    entity: ProfileCmsPackageEntity
  ): void {
    if (computeCmsPackageHash(cmsPackage) !== entity.package_hash) {
      throw new BadRequestException(
        'CMS package hash does not match the stored draft; refusing to upload'
      );
    }
  }

  private findCanonicalArweaveReceipt(
    cmsPackage: CmsPackageV1,
    packageHash: string
  ): CmsStorageReceiptV1 | undefined {
    return cmsPackage.storage.find(
      (receipt) =>
        receipt.provider === 'arweave' &&
        receipt.canonical &&
        receipt.content_hash === packageHash
    );
  }

  private async uploadCanonicalJsonToArweave(
    fileBuffer: Buffer
  ): Promise<string> {
    if (!process.env.ARWEAVE_KEY) {
      throw new CustomApiCompliantException(
        500,
        'Arweave storage is not configured'
      );
    }
    let transactionId: string;
    try {
      ({ transaction_id: transactionId } =
        await this.arweaveUploader.uploadFileWithTransactionId(
          fileBuffer,
          'application/json'
        ));
    } catch (error) {
      logger.error(`Arweave upload failed: ${error}`);
      throw new CustomApiCompliantException(
        502,
        'Failed to upload CMS package to Arweave storage'
      );
    }
    if (!isLikelyArweaveTransactionId(transactionId)) {
      logger.error(
        `Arweave upload returned an unexpected transaction id: ${transactionId}`
      );
      throw new CustomApiCompliantException(
        502,
        'Failed to upload CMS package to Arweave storage'
      );
    }
    return transactionId;
  }

  private async persistStorageReceipt(
    entity: ProfileCmsPackageEntity,
    cmsPackage: CmsPackageV1,
    receipt: CmsStorageReceiptV1,
    ctx: RequestContext
  ): Promise<void> {
    const otherReceipts = cmsPackage.storage.filter(
      (existing) => !(existing.provider === 'arweave' && existing.canonical)
    );
    const updatedPackage: CmsPackageV1 = {
      ...cmsPackage,
      storage: [...otherReceipts, receipt]
    };
    await this.packagesDb.updateStorageReceipt(
      {
        id: entity.id,
        cms_package: updatedPackage,
        storage_receipts: updatedPackage.storage,
        storage_provider: receipt.provider,
        storage_uri: receipt.uri,
        storage_content_hash: receipt.content_hash,
        storage_provider_content_id: receipt.provider_content_id ?? null,
        storage_recorded_at: receipt.recorded_at,
        storage_pinned: receipt.pinned ?? null,
        storage_canonical: receipt.canonical ?? null,
        updated_at: Time.currentMillis()
      },
      ctx
    );
  }

  async exportPackage(
    id: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageExportResponse> {
    const entity = await this.getReadablePackageEntityOrThrow(id, ctx);
    const pointerEvents = await this.pointerEventsDb.listByPackageId(
      entity.id,
      ctx
    );
    return this.toExportResponse(entity, pointerEvents);
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
    const profile = await this.getProfileIdentityOrThrow(handle, ctx);
    const entity = await this.packagesDb.findPrimaryPublishedByProfileId(
      profile.id,
      ctx
    );
    if (
      !entity ||
      !this.isPublicPackage(entity) ||
      entity.profile_handle.toLowerCase() !== profile.handle.toLowerCase()
    ) {
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
    const privateEntity = (
      await this.packagesDb.findAllByHash(packageHash, ctx)
    ).find((entity) =>
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
    return this.toPackageResponse(
      this.getReadablePackageEntityOrThrowFromEntity(entity, ctx)
    );
  }

  private getReadablePackageEntityOrThrowFromEntity(
    entity: ProfileCmsPackageEntity,
    ctx: RequestContext
  ): ProfileCmsPackageEntity {
    if (
      entity.status === ProfileCmsPackageStatus.PUBLISHED &&
      this.isPublicPackage(entity)
    ) {
      return entity;
    }

    if (!this.canManageProfile(entity.profile_id, ctx.authenticationContext)) {
      throw new NotFoundException(
        `Profile CMS package ${entity.id} was not found`
      );
    }
    return entity;
  }

  private async getReadablePackageEntityOrThrow(
    id: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageEntity> {
    return this.getReadablePackageEntityOrThrowFromEntity(
      await this.getPackageEntityOrThrow(id, ctx),
      ctx
    );
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

  private async markPublishFailed(
    id: string,
    validationResult: CmsValidationResultV1,
    validationError: string,
    ctx: RequestContext
  ): Promise<void> {
    const failedAt = Time.currentMillis();
    await this.packagesDb.markValidating(id, failedAt, ctx);
    await this.packagesDb.markFailed(
      id,
      validationResult,
      validationError,
      failedAt,
      ctx
    );
  }

  private buildPublishFailureValidation(
    entity: ProfileCmsPackageEntity
  ): CmsValidationResultV1 {
    return validateCmsPackageV1(entity.cms_package, {
      allowFixtureSignatures: false,
      allowFixtureStorage: false,
      enforceHashes: true
    });
  }

  private getSignedCanonicalReceiptOrThrow(
    storedPackage: CmsPackageV1
  ): CmsStorageReceiptV1 {
    const canonicalReceipts = storedPackage.storage.filter(
      (receipt) => receipt.canonical
    );
    if (canonicalReceipts.length !== 1) {
      throw new BadRequestException(
        'CMS package must have exactly one canonical storage receipt to publish'
      );
    }
    return canonicalReceipts[0];
  }

  private buildRebuiltPublishPackage(
    storedPackage: CmsPackageV1,
    signatureVerification: ProfileCmsPublishSignatureVerificationResult,
    signatureRequest: ProfileCmsPublishSignatureRequest
  ): CmsPackageV1 {
    if (!signatureVerification.signer_address) {
      throw new BadRequestException('CMS publish signature signer is missing');
    }
    const deepCopy = JSON.parse(JSON.stringify(storedPackage)) as CmsPackageV1;
    return {
      ...deepCopy,
      signatures: [
        this.buildPublishSignatureEnvelope(
          signatureVerification,
          signatureRequest
        )
      ],
      // Drop every fixture-provider receipt; keep the real receipts (including
      // the real canonical one the storage validator will re-check).
      storage: deepCopy.storage.filter(
        (receipt) => receipt.provider !== 'fixture'
      )
    };
  }

  private buildPublishSignatureEnvelope(
    signatureVerification: ProfileCmsPublishSignatureVerificationResult,
    signatureRequest: ProfileCmsPublishSignatureRequest
  ): CmsSignatureEnvelopeV1 {
    return {
      type: 'eip712',
      signer: signatureVerification.signer_address as string,
      signature: signatureRequest.signature,
      signed_at: this.getCurrentIsoDate(),
      domain: {
        ...signatureVerification.typed_data.domain,
        typed_data_hash: signatureVerification.typed_data_hash
      }
    };
  }

  private async persistRebuiltPublishPackage(
    id: string,
    rebuiltPackage: CmsPackageV1,
    canonicalReceipt: CmsStorageReceiptV1,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.packagesDb.updateStorageReceipt(
      {
        id,
        cms_package: rebuiltPackage,
        storage_receipts: rebuiltPackage.storage,
        storage_provider: canonicalReceipt.provider,
        storage_uri: canonicalReceipt.uri,
        storage_content_hash: canonicalReceipt.content_hash,
        storage_provider_content_id:
          canonicalReceipt.provider_content_id ?? null,
        storage_recorded_at: canonicalReceipt.recorded_at,
        storage_pinned: canonicalReceipt.pinned ?? null,
        storage_canonical: canonicalReceipt.canonical ?? null,
        updated_at: now
      },
      ctx
    );
  }

  private parsePackageOrThrow(input: unknown): CmsPackageV1 {
    const parsed = cmsPackageSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException('CMS package does not match V1 schema');
    }
    return parsed.data;
  }

  private async getProfileIdentityOrThrow(
    profileId: string,
    ctx: RequestContext
  ): Promise<ProfileHandleIdentity> {
    const identity =
      await this.identityFetcher.getIdentityAndConsolidationsByIdentityKey(
        { identityKey: profileId },
        ctx
      );
    if (!identity?.handle || !identity.id || !identity.primary_wallet) {
      throw new NotFoundException(`Profile ${profileId} not found`);
    }
    const wallets = new Set(
      [
        identity.primary_wallet,
        ...(identity.wallets ?? []).map((it) => it.wallet)
      ]
        .map((wallet) => normalizeWallet(wallet))
        .filter((wallet): wallet is string => !!wallet)
    );
    return {
      id: identity.id,
      handle: identity.handle,
      wallets
    };
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

  private assertPackageWalletsMatch(
    cmsPackage: CmsPackageV1,
    profile: ProfileHandleIdentity
  ): void {
    const packagePrimaryWallet = normalizeWallet(
      cmsPackage.profile.primary_wallet
    );
    if (!packagePrimaryWallet || !profile.wallets.has(packagePrimaryWallet)) {
      throw new BadRequestException(
        'CMS package primary_wallet does not belong to the profile'
      );
    }
    cmsPackage.signatures
      .filter((signature) => signature.type === 'eip712')
      .forEach((signature) => {
        const signer = normalizeWallet(signature.signer);
        if (!signer || !profile.wallets.has(signer)) {
          throw new BadRequestException(
            'CMS package eip712 signer does not belong to the profile'
          );
        }
      });
  }

  private assertSignerWalletMatchesProfile(
    signerAddress: string | null,
    profile: ProfileHandleIdentity
  ): void {
    if (!signerAddress || !profile.wallets.has(signerAddress)) {
      throw new BadRequestException(
        'CMS publish signature signer does not belong to the profile'
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

  private assertExpectedPackageHash(
    entity: ProfileCmsPackageEntity,
    expectedPackageHash: string | undefined
  ): void {
    if (expectedPackageHash && expectedPackageHash !== entity.package_hash) {
      throw new BadRequestException(
        'Expected package hash does not match CMS package'
      );
    }
  }

  private assertExpectedCurrentPrimary(
    currentPrimary: ProfileCmsPackageEntity | null,
    request: RollbackProfileCmsPackageRequest
  ): void {
    if (!currentPrimary) {
      throw new BadRequestException('Profile has no current primary package');
    }
    if (currentPrimary.id !== request.expected_current_package_id) {
      throw new BadRequestException('Expected current package id mismatch');
    }
    if (
      request.expected_current_package_hash &&
      currentPrimary.package_hash !== request.expected_current_package_hash
    ) {
      throw new BadRequestException('Expected current package hash mismatch');
    }
  }

  private assertDraftCanBePublished(entity: ProfileCmsPackageEntity): void {
    if (entity.status !== ProfileCmsPackageStatus.DRAFT) {
      throw new BadRequestException('Only draft CMS packages can be published');
    }
  }

  private assertPackageCanBecomePrimary(entity: ProfileCmsPackageEntity): void {
    if (
      entity.status !== ProfileCmsPackageStatus.PUBLISHED &&
      entity.status !== ProfileCmsPackageStatus.SUPERSEDED
    ) {
      throw new BadRequestException(
        'Only published or superseded CMS packages can become primary'
      );
    }
    if (
      !entity.production_valid ||
      !this.isProductionSafePackage(entity.cms_package)
    ) {
      throw new BadRequestException(
        'Only production-valid CMS packages can become primary'
      );
    }
  }

  private assertPublishSignatureRequest(
    request: PublishProfileCmsPackageRequest
  ): asserts request is PublishProfileCmsPackageRequest &
    ProfileCmsPublishSignatureRequest {
    if (!request.signer_address || !request.signature) {
      throw new BadRequestException('CMS publish signature is required');
    }
    if (!Number.isInteger(request.chain_id) || request.chain_id < 1) {
      throw new BadRequestException('CMS publish chain_id is invalid');
    }
  }

  private assertPublishDeadline(deadline: number): void {
    const now = Time.currentMillis();
    if (!Number.isInteger(deadline) || deadline < now) {
      throw new BadRequestException('CMS publish signature is expired');
    }
    if (deadline > now + PROFILE_CMS_PUBLISH_MAX_DEADLINE_MS) {
      throw new BadRequestException(
        'CMS publish signature deadline is too far in the future'
      );
    }
  }

  private assertPublishSignatureVerified(
    result: ProfileCmsPublishSignatureVerificationResult
  ): void {
    if (!result.valid) {
      throw new BadRequestException(
        `CMS publish signature is invalid: ${result.reason ?? 'unknown'}`
      );
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
      entity.production_valid &&
      this.isProductionSafePackage(entity.cms_package)
    );
  }

  private isProductionSafePackage(input: unknown): boolean {
    if (!isRecord(input)) {
      return false;
    }
    const signatures = input.signatures;
    const storage = input.storage;
    return (
      Array.isArray(signatures) &&
      signatures.every(
        (signature) => isRecord(signature) && signature.type !== 'fixture'
      ) &&
      Array.isArray(storage) &&
      storage.every(
        (receipt) => isRecord(receipt) && receipt.provider !== 'fixture'
      )
    );
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

  private async recordPointerEvents(
    events: ProfileCmsPointerEventEntity[],
    ctx: RequestContext
  ): Promise<void> {
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      await this.pointerEventsDb.insert(
        {
          ...event,
          event_sequence: index
        },
        ctx
      );
    }
  }

  private async consumePublishSignatureOrThrow(
    entity: ProfileCmsPackageEntity,
    request: ProfileCmsPublishSignatureRequest,
    signatureVerification: ProfileCmsPublishSignatureVerificationResult,
    ctx: RequestContext
  ): Promise<void> {
    if (!signatureVerification.signer_address) {
      throw new BadRequestException('CMS publish signature signer is missing');
    }
    const consumed = await this.publishSignaturesDb.insertConsumed(
      {
        id: randomUUID(),
        typed_data_hash: signatureVerification.typed_data_hash,
        profile_id: entity.profile_id,
        package_db_id: entity.id,
        package_id: entity.package_id,
        package_version: entity.version,
        package_hash: entity.package_hash,
        signer_address: signatureVerification.signer_address,
        deadline: request.deadline,
        created_at: Time.currentMillis()
      },
      ctx
    );
    if (!consumed) {
      throw new BadRequestException(
        'CMS publish signature has already been consumed'
      );
    }
  }

  private toPointerEvent({
    eventType,
    entity,
    previousPackageDbId,
    actorProfileId,
    signatureVerification,
    signatureRequest,
    storageReceipt,
    createdAt
  }: {
    readonly eventType: ProfileCmsPointerEventType;
    readonly entity: ProfileCmsPackageEntity;
    readonly previousPackageDbId: string | null;
    readonly actorProfileId: string;
    readonly signatureVerification?: ProfileCmsPublishSignatureVerificationResult;
    readonly signatureRequest?: ProfileCmsPublishSignatureRequest;
    readonly storageReceipt?: CmsPackageV1['storage'][number];
    readonly createdAt: number;
  }): ProfileCmsPointerEventEntity {
    return {
      id: randomUUID(),
      event_type: eventType,
      profile_id: entity.profile_id,
      profile_handle: entity.profile_handle,
      package_db_id: entity.id,
      package_id: entity.package_id,
      package_version: entity.version,
      package_hash: entity.package_hash,
      payload_hash: entity.payload_hash,
      previous_package_db_id: previousPackageDbId,
      actor_profile_id: actorProfileId,
      signer_address: signatureVerification?.signer_address ?? null,
      signature: signatureRequest?.signature ?? null,
      typed_data: signatureVerification?.typed_data ?? null,
      typed_data_hash: signatureVerification?.typed_data_hash ?? null,
      storage_receipt: storageReceipt ?? null,
      event_sequence: 0,
      created_at: createdAt
    };
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

  private toExportResponse(
    entity: ProfileCmsPackageEntity,
    pointerEvents: ProfileCmsPointerEventEntity[]
  ): ProfileCmsPackageExportResponse {
    return {
      package: entity.cms_package,
      package_id: entity.package_id,
      package_db_id: entity.id,
      version: entity.version,
      status: entity.status.toLowerCase(),
      profile_id: entity.profile_id,
      profile_handle: entity.profile_handle,
      primary_path: entity.primary_path,
      package_hash: entity.package_hash,
      payload_hash: entity.payload_hash,
      storage_receipts: entity.storage_receipts,
      pointer_events: pointerEvents.map((event) =>
        this.toPointerEventResponse(event)
      ),
      updated_at: entity.updated_at,
      ...(entity.published_at ? { published_at: entity.published_at } : {})
    };
  }

  private toPointerEventResponse(
    entity: ProfileCmsPointerEventEntity
  ): ProfileCmsPointerEventResponse {
    return {
      id: entity.id,
      event_type: entity.event_type.toLowerCase(),
      profile_id: entity.profile_id,
      profile_handle: entity.profile_handle,
      package_id: entity.package_id,
      package_db_id: entity.package_db_id,
      package_version: entity.package_version,
      package_hash: entity.package_hash,
      payload_hash: entity.payload_hash,
      ...(entity.previous_package_db_id
        ? { previous_package_db_id: entity.previous_package_db_id }
        : {}),
      actor_profile_id: entity.actor_profile_id,
      ...(entity.signer_address
        ? { signer_address: entity.signer_address }
        : {}),
      ...(entity.typed_data_hash
        ? { typed_data_hash: entity.typed_data_hash }
        : {}),
      ...(entity.storage_receipt
        ? { storage_receipt: entity.storage_receipt }
        : {}),
      event_sequence: entity.event_sequence,
      created_at: entity.created_at
    };
  }

  private getCurrentIsoDate(): string {
    return new Date(Time.currentMillis()).toISOString();
  }
}

export const profileCmsApiService = new ProfileCmsApiService(
  profileCmsPackagesDb,
  identityFetcher,
  profileCmsPointerEventsDb,
  profileCmsPublishSignaturesDb,
  profileCmsStorageReceiptVerifier
);

function normalizeWallet(wallet: string | null | undefined): string | null {
  return typeof wallet === 'string' ? wallet.toLowerCase() : null;
}

function isLikelyArweaveTransactionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
