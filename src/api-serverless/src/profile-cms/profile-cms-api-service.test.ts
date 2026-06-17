jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: {},
  IdentityFetcher: jest.fn()
}));

import { AuthenticationContext } from '@/auth-context';
import { ProfileCmsApiService } from '@/api/profile-cms/profile-cms.api.service';
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
import { ProfileCmsPackagesDb } from '@/profile-cms/profile-cms-packages.db';
import { CmsPackageV1 } from '@/profile-cms/protocol/v1';
import { RequestContext } from '@/request.context';
import { ConnectionWrapper } from '@/sql-executor';
import {
  createFixtureProfileCmsSignature,
  createFixtureProfileCmsStorageReceipt,
  createValidProfileCmsPackage,
  PROFILE_CMS_FIXTURE_HANDLE,
  PROFILE_CMS_FIXTURE_PROFILE_ID,
  PROFILE_CMS_FIXTURE_ZERO_HASH
} from '@/tests/fixtures/profile-cms-package.fixture';
import type { IdentityFetcher } from '@/api/identities/identity.fetcher';

type PackagesDbMock = Pick<
  ProfileCmsPackagesDb,
  | 'getNextVersion'
  | 'insert'
  | 'findById'
  | 'findByHash'
  | 'findByVersion'
  | 'findPrimaryPublishedByHandle'
  | 'listByProfile'
  | 'markFailed'
  | 'markPublished'
  | 'markValidating'
  | 'supersedePrimaryForProfile'
  | 'executeNativeQueriesInTransaction'
>;

type IdentityFetcherMock = Pick<
  IdentityFetcher,
  'getIdentityAndConsolidationsByIdentityKey'
>;

describe('ProfileCmsApiService', () => {
  let packagesDb: jest.Mocked<PackagesDbMock>;
  let identityFetcher: jest.Mocked<IdentityFetcherMock>;
  let service: ProfileCmsApiService;

  beforeEach(() => {
    packagesDb = {
      getNextVersion: jest.fn(),
      insert: jest.fn(),
      findById: jest.fn(),
      findByHash: jest.fn(),
      findByVersion: jest.fn(),
      findPrimaryPublishedByHandle: jest.fn(),
      listByProfile: jest.fn(),
      markFailed: jest.fn(),
      markPublished: jest.fn(),
      markValidating: jest.fn(),
      supersedePrimaryForProfile: jest.fn(),
      executeNativeQueriesInTransaction: jest.fn()
    };
    identityFetcher = {
      getIdentityAndConsolidationsByIdentityKey: jest.fn()
    };
    identityFetcher.getIdentityAndConsolidationsByIdentityKey.mockResolvedValue(
      {
        id: PROFILE_CMS_FIXTURE_PROFILE_ID,
        handle: PROFILE_CMS_FIXTURE_HANDLE
      } as never
    );
    packagesDb.executeNativeQueriesInTransaction.mockImplementation(
      async (callback) => callback({} as unknown as ConnectionWrapper<unknown>)
    );
    service = new ProfileCmsApiService(
      packagesDb as unknown as ProfileCmsPackagesDb,
      identityFetcher as unknown as IdentityFetcher
    );
  });

  it('saves a draft CMS package for the profile owner', async () => {
    const cmsPackage = createValidProfileCmsPackage();
    packagesDb.getNextVersion.mockResolvedValue(1);
    packagesDb.insert.mockImplementation(async (entity) =>
      createEntity(entity)
    );

    const result = await service.saveDraft(
      {
        profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
        cms_package: cmsPackage
      },
      ownerContext()
    );

    expect(result).toMatchObject({
      id: expect.any(String),
      package: cmsPackage,
      profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
      profile_handle: PROFILE_CMS_FIXTURE_HANDLE,
      package_id: cmsPackage.package_id,
      version: 1,
      status: 'draft',
      package_hash: cmsPackage.integrity.package_hash,
      payload_hash: cmsPackage.integrity.payload_hash
    });
    expect(packagesDb.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ProfileCmsPackageStatus.DRAFT,
        storage_provider: 'ipfs',
        storage_uri: 'ipfs://bafybeicmsv1fixture',
        storage_content_hash: PROFILE_CMS_FIXTURE_ZERO_HASH,
        storage_provider_content_id: 'bafybeicmsv1fixture',
        storage_pinned: true,
        storage_canonical: true
      }),
      expect.any(Object)
    );
  });

  it('allows a delegated CMS publisher to save drafts', async () => {
    const cmsPackage = createValidProfileCmsPackage();
    packagesDb.getNextVersion.mockResolvedValue(1);
    packagesDb.insert.mockImplementation(async (entity) =>
      createEntity(entity)
    );

    await expect(
      service.saveDraft(
        {
          profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
          cms_package: cmsPackage
        },
        delegatedPublisherContext()
      )
    ).resolves.toMatchObject({ status: 'draft' });
  });

  it('rejects draft saves without profile CMS publish permissions', async () => {
    await expect(
      service.saveDraft(
        {
          profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
          cms_package: createValidProfileCmsPackage()
        },
        { authenticationContext: AuthenticationContext.notAuthenticated() }
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(packagesDb.insert).not.toHaveBeenCalled();
  });

  it('rejects publish when the expected package hash does not match', async () => {
    const entity = createEntity();
    packagesDb.findById.mockResolvedValue(entity);

    await expect(
      service.publish(
        entity.id,
        { expected_package_hash: PROFILE_CMS_FIXTURE_ZERO_HASH },
        ownerContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(packagesDb.markValidating).not.toHaveBeenCalled();
  });

  it('rejects invalid packages before production publish and records failure state', async () => {
    const invalidPackage = createFixtureOnlyPackage();
    const entity = createEntity({
      cms_package: invalidPackage,
      payload_hash: invalidPackage.integrity.payload_hash,
      package_hash: invalidPackage.integrity.package_hash
    });
    packagesDb.findById.mockResolvedValue(entity);

    await expect(
      service.publish(entity.id, {}, ownerContext())
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(packagesDb.markValidating).toHaveBeenCalledWith(
      entity.id,
      expect.any(Number),
      expect.any(Object)
    );
    expect(packagesDb.markFailed).toHaveBeenCalledWith(
      entity.id,
      expect.objectContaining({ valid: false }),
      expect.stringContaining('signature.fixture_not_allowed'),
      expect.any(Number),
      expect.any(Object)
    );
    expect(packagesDb.markPublished).not.toHaveBeenCalled();
  });

  it('publishes a valid draft and supersedes the previous primary package', async () => {
    const draft = createEntity();
    const published = createEntity({
      id: draft.id,
      status: ProfileCmsPackageStatus.PUBLISHED,
      is_primary: true,
      published_at: 1234
    });
    packagesDb.findById
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce(published);

    const result = await service.publish(
      draft.id,
      {
        expected_package_hash: draft.package_hash,
        expected_payload_hash: draft.payload_hash
      },
      ownerContext()
    );

    expect(packagesDb.supersedePrimaryForProfile).toHaveBeenCalledWith(
      PROFILE_CMS_FIXTURE_PROFILE_ID,
      draft.id,
      expect.any(Number),
      expect.objectContaining({ connection: expect.any(Object) })
    );
    expect(packagesDb.markPublished).toHaveBeenCalledWith(
      draft.id,
      PROFILE_CMS_FIXTURE_PROFILE_ID,
      expect.objectContaining({ valid: true }),
      expect.any(Number),
      expect.objectContaining({ connection: expect.any(Object) })
    );
    expect(result).toMatchObject({
      id: draft.id,
      status: 'published',
      published_at: 1234
    });
  });

  it('returns 404 when a profile has no primary published CMS package', async () => {
    packagesDb.findPrimaryPublishedByHandle.mockResolvedValue(null);

    await expect(
      service.getPrimaryByHandle(PROFILE_CMS_FIXTURE_HANDLE, {})
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not expose fixture packages through primary public lookup', async () => {
    packagesDb.findPrimaryPublishedByHandle.mockResolvedValue(
      createEntity({
        cms_package: createFixtureOnlyPackage(),
        status: ProfileCmsPackageStatus.PUBLISHED,
        is_primary: true,
        published_at: 1234
      })
    );

    await expect(
      service.getPrimaryByHandle(PROFILE_CMS_FIXTURE_HANDLE, {})
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not expose hash-invalid packages through primary public lookup', async () => {
    packagesDb.findPrimaryPublishedByHandle.mockResolvedValue(
      createEntity({
        cms_package: createHashMismatchPackage(),
        status: ProfileCmsPackageStatus.PUBLISHED,
        is_primary: true,
        published_at: 1234
      })
    );

    await expect(
      service.getPrimaryByHandle(PROFILE_CMS_FIXTURE_HANDLE, {})
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('serves the first production-safe published package by hash', async () => {
    const fixturePackage = createFixtureOnlyPackage();
    const productionPackage = createValidProfileCmsPackage();
    const fixtureEntity = createEntity({
      id: 'fixture-row',
      cms_package: fixturePackage,
      status: ProfileCmsPackageStatus.PUBLISHED,
      is_primary: true,
      published_at: 2
    });
    const productionEntity = createEntity({
      id: 'production-row',
      cms_package: productionPackage,
      status: ProfileCmsPackageStatus.PUBLISHED,
      is_primary: true,
      published_at: 1
    });
    packagesDb.findByHash.mockResolvedValue([fixtureEntity, productionEntity]);

    const result = await service.getByHash(
      productionPackage.integrity.package_hash,
      { authenticationContext: AuthenticationContext.notAuthenticated() }
    );

    expect(result).toMatchObject({
      id: 'production-row',
      package_hash: productionPackage.integrity.package_hash
    });
  });
});

function createEntity(
  overrides: Partial<ProfileCmsPackageEntity> = {}
): ProfileCmsPackageEntity {
  const cmsPackage =
    (overrides.cms_package as CmsPackageV1 | undefined) ??
    createValidProfileCmsPackage();
  const now = 1000;
  return {
    id: 'cms-package-id',
    profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
    profile_handle: PROFILE_CMS_FIXTURE_HANDLE,
    package_id: cmsPackage.package_id,
    version: 1,
    status: ProfileCmsPackageStatus.DRAFT,
    cms_package: cmsPackage,
    payload_hash: cmsPackage.integrity.payload_hash,
    package_hash: cmsPackage.integrity.package_hash,
    primary_path: `/${PROFILE_CMS_FIXTURE_HANDLE}/index.html`,
    is_primary: false,
    created_by_profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
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
    storage_provider: cmsPackage.storage[0]?.provider ?? null,
    storage_uri: cmsPackage.storage[0]?.uri ?? null,
    storage_content_hash: cmsPackage.storage[0]?.content_hash ?? null,
    storage_provider_content_id:
      cmsPackage.storage[0]?.provider_content_id ?? null,
    storage_recorded_at: cmsPackage.storage[0]?.recorded_at ?? null,
    storage_pinned: cmsPackage.storage[0]?.pinned ?? null,
    storage_canonical: cmsPackage.storage[0]?.canonical ?? null,
    ...overrides
  };
}

function createFixtureOnlyPackage(): CmsPackageV1 {
  return {
    ...createValidProfileCmsPackage(),
    signatures: [createFixtureProfileCmsSignature()],
    storage: [createFixtureProfileCmsStorageReceipt()]
  };
}

function createHashMismatchPackage(): CmsPackageV1 {
  const cmsPackage = createValidProfileCmsPackage();
  return {
    ...cmsPackage,
    integrity: {
      ...cmsPackage.integrity,
      package_hash: PROFILE_CMS_FIXTURE_ZERO_HASH
    }
  };
}

function ownerContext(): RequestContext {
  return {
    authenticationContext: AuthenticationContext.fromProfileId(
      PROFILE_CMS_FIXTURE_PROFILE_ID
    )
  };
}

function delegatedPublisherContext(): RequestContext {
  return {
    authenticationContext: new AuthenticationContext({
      authenticatedWallet: null,
      authenticatedProfileId: 'delegate-profile',
      roleProfileId: PROFILE_CMS_FIXTURE_PROFILE_ID,
      activeProxyActions: [
        {
          id: 'publish-cms-action',
          type: ProfileProxyActionType.PUBLISH_CMS,
          credit_amount: null,
          credit_spent: null
        }
      ]
    })
  };
}
