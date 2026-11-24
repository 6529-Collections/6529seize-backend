jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: {},
  IdentityFetcher: jest.fn()
}));

import { ArweaveFileUploader } from '@/arweave';
import { AuthenticationContext } from '@/auth-context';
import {
  closeAfterCommitScope,
  openAfterCommitScope,
  runBeforeCommitChecks
} from '@/db/after-commit';
import {
  ProfileCmsPackageEntity,
  ProfileCmsPackageStatus
} from '@/entities/IProfileCmsPackage';
import {
  apiCompliantErrorBody,
  CustomApiCompliantException
} from '@/exceptions';
import type { IdentityFetcher } from '@/api/identities/identity.fetcher';
import { ProfileCmsApiService } from '@/api/profile-cms/profile-cms.api.service';
import { ProfileCmsPackagesDb } from '@/profile-cms/profile-cms-packages.db';
import { ProfileCmsPointerEventsDb } from '@/profile-cms/profile-cms-pointer-events.db';
import { ProfileCmsPublicationStorage } from '@/profile-cms/profile-cms-publication-storage';
import { ProfileCmsPublishSignaturesDb } from '@/profile-cms/profile-cms-publish-signatures.db';
import { ProfileCmsPublishSignatureVerificationResult } from '@/profile-cms/profile-cms-signing';
import { ProfileCmsStorageReceiptVerifier } from '@/profile-cms/profile-cms-storage';
import { ProfileCmsUploadsDb } from '@/profile-cms/profile-cms-uploads.db';
import { CmsPackageV1 } from '@/profile-cms/protocol/v1';
import { RequestContext } from '@/request.context';
import {
  createValidProfileCmsPackage,
  PROFILE_CMS_FIXTURE_HANDLE,
  PROFILE_CMS_FIXTURE_PROFILE_ID,
  PROFILE_CMS_FIXTURE_ZERO_HASH
} from '@/tests/fixtures/profile-cms-package.fixture';
import {
  clearFreezeSettings,
  expectCommitted,
  fakeTransactionalDb,
  freezeClock,
  settle
} from '@/tests/fixtures/freeze-at-commit.fixture';

const SIGNER = '0xf58fE66AF1A8C792Cd64D8d706edDabAdFCB2FD0';

function createEntity(
  overrides: Partial<ProfileCmsPackageEntity> = {}
): ProfileCmsPackageEntity {
  const cmsPackage =
    (overrides.cms_package as CmsPackageV1 | undefined) ??
    createValidProfileCmsPackage();
  const status = overrides.status ?? ProfileCmsPackageStatus.DRAFT;
  return {
    id: 'cms-package-id',
    profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
    profile_handle: PROFILE_CMS_FIXTURE_HANDLE,
    package_id: cmsPackage.package_id,
    version: 1,
    status,
    cms_package: cmsPackage,
    payload_hash: cmsPackage.integrity.payload_hash,
    package_hash: cmsPackage.integrity.package_hash,
    primary_path: `/${PROFILE_CMS_FIXTURE_HANDLE}/index.html`,
    is_primary: false,
    production_valid: status === ProfileCmsPackageStatus.PUBLISHED,
    created_by_profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
    published_by_profile_id: null,
    created_at: 1000,
    updated_at: 1000,
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

function signatureVerification(): ProfileCmsPublishSignatureVerificationResult {
  return {
    valid: true,
    signer_address: SIGNER.toLowerCase(),
    typed_data: {
      domain: { name: '6529 Profile CMS', version: '1', chainId: 1 },
      types: {},
      message: {
        action: 'publish',
        profileId: PROFILE_CMS_FIXTURE_PROFILE_ID,
        handle: PROFILE_CMS_FIXTURE_HANDLE,
        packageId: 'profile-native-home',
        version: 1,
        draftId: 'cms-package-id',
        payloadHash: PROFILE_CMS_FIXTURE_ZERO_HASH,
        packageHash: PROFILE_CMS_FIXTURE_ZERO_HASH,
        primaryPath: `/${PROFILE_CMS_FIXTURE_HANDLE}/index.html`,
        storageProvider: 'ipfs',
        storageUri:
          'ipfs://bafybeigdyrztmrgfydgytzqojqfaytmqmvqwxqk66xcs4i6hj5yq',
        storageContentHash: PROFILE_CMS_FIXTURE_ZERO_HASH,
        deadline: Date.now() + 5 * 60_000
      }
    },
    typed_data_hash: '0xtypeddatahash'
  } as ProfileCmsPublishSignatureVerificationResult;
}

function ownerContext(): RequestContext {
  return {
    authenticationContext: AuthenticationContext.fromProfileId(
      PROFILE_CMS_FIXTURE_PROFILE_ID
    )
  };
}

/**
 * A profile site service whose package writes run in a transaction of the
 * real my-sql.helpers on a fake connection. `onLock` runs at the first lock
 * each write takes inside its transaction.
 */
function setup(onLock: () => void) {
  const tx = fakeTransactionalDb();
  const packagesDb = {
    executeNativeQueriesInTransaction: tx.executeNativeQueriesInTransaction,
    findById: jest.fn(),
    findByIdForUpdate: jest.fn(),
    findPrimaryPublishedByProfileId: jest.fn(),
    findPrimaryPublishedByProfileIdForUpdate: jest.fn(),
    lockProfilePackagesForUpdate: jest.fn(async () => {
      onLock();
      return PROFILE_CMS_FIXTURE_HANDLE;
    }),
    setRecoveryReceipt: jest.fn(),
    markValidating: jest.fn(),
    markPublished: jest.fn(),
    markPrimary: jest.fn(),
    supersedePrimaryForProfile: jest.fn(),
    updateStorageReceipt: jest.fn(),
    recordPublication: jest.fn(),
    unpublish: jest.fn(),
    archive: jest.fn()
  };
  const identityFetcher = {
    getIdentityAndConsolidationsByIdentityKey: jest.fn().mockResolvedValue({
      id: PROFILE_CMS_FIXTURE_PROFILE_ID,
      handle: PROFILE_CMS_FIXTURE_HANDLE,
      primary_wallet: SIGNER,
      wallets: [{ wallet: SIGNER }]
    })
  };
  const pointerEventsDb = {
    insert: jest.fn(),
    listByPackageId: jest.fn().mockResolvedValue([])
  };
  const publishSignaturesDb = {
    insertConsumed: jest.fn().mockResolvedValue(true)
  };
  const arweaveUploader = {
    uploadFileWithTransactionId: jest.fn().mockResolvedValue({
      url: 'https://arweave.net/' + 'a'.repeat(43),
      transaction_id: 'a'.repeat(43)
    })
  };
  const publicationStorage = new ProfileCmsPublicationStorage(
    {
      reserve: jest.fn(async (id: string) => ({ id, token: 'lease' })),
      saveState: jest.fn(),
      complete: jest.fn(),
      release: jest.fn()
    } as unknown as ProfileCmsUploadsDb,
    arweaveUploader as unknown as ArweaveFileUploader
  );
  jest.spyOn(publicationStorage, 'verify').mockResolvedValue(Buffer.from('{}'));
  const service = new ProfileCmsApiService(
    packagesDb as unknown as ProfileCmsPackagesDb,
    identityFetcher as unknown as IdentityFetcher,
    pointerEventsDb as unknown as ProfileCmsPointerEventsDb,
    publishSignaturesDb as unknown as ProfileCmsPublishSignaturesDb,
    new ProfileCmsStorageReceiptVerifier(),
    jest.fn(async () => signatureVerification()),
    arweaveUploader as unknown as ArweaveFileUploader,
    publicationStorage
  );
  return { tx, packagesDb, service };
}

type Fixture = ReturnType<typeof setup>;

/** Each write of a profile site, with the package rows it needs. */
const WRITES: Record<
  'publish' | 'rollbackPrimary' | 'unpublishPackage' | 'archivePackage',
  (fixture: Fixture, onLock: () => void) => Promise<unknown>
> = {
  publish: ({ service, packagesDb }) => {
    const draft = createEntity();
    const previous = createEntity({
      id: 'previous-primary',
      status: ProfileCmsPackageStatus.PUBLISHED,
      is_primary: true,
      published_at: 1000,
      production_valid: true
    });
    packagesDb.findById
      .mockResolvedValueOnce(draft)
      .mockResolvedValue(
        createEntity({ status: ProfileCmsPackageStatus.PUBLISHED })
      );
    packagesDb.findByIdForUpdate.mockResolvedValue(draft);
    packagesDb.findPrimaryPublishedByProfileId.mockResolvedValue(previous);
    packagesDb.findPrimaryPublishedByProfileIdForUpdate.mockResolvedValue(
      previous
    );
    return service.publish(
      draft.id,
      {
        expected_current_package_id: previous.id,
        expected_package_hash: draft.package_hash,
        expected_payload_hash: draft.payload_hash,
        signer_address: SIGNER,
        signature: '0xsignature',
        chain_id: 1,
        deadline: Date.now() + 5 * 60_000
      } as any,
      ownerContext()
    );
  },
  rollbackPrimary: ({ service, packagesDb }) => {
    const target = createEntity({
      id: 'previous-package',
      status: ProfileCmsPackageStatus.SUPERSEDED,
      production_valid: true,
      published_at: 1000
    });
    const current = createEntity({
      id: 'current-package',
      status: ProfileCmsPackageStatus.PUBLISHED,
      production_valid: true,
      is_primary: true,
      published_at: 2000
    });
    packagesDb.findById.mockResolvedValue(target);
    packagesDb.findByIdForUpdate.mockResolvedValue(target);
    packagesDb.findPrimaryPublishedByProfileIdForUpdate.mockResolvedValue(
      current
    );
    return service.rollbackPrimary(
      target.id,
      {
        expected_current_package_id: current.id,
        expected_current_package_hash: current.package_hash
      },
      ownerContext()
    );
  },
  unpublishPackage: ({ service, packagesDb }) => {
    const current = createEntity({
      status: ProfileCmsPackageStatus.PUBLISHED,
      production_valid: true,
      is_primary: true,
      published_at: 2000
    });
    packagesDb.findById.mockResolvedValue(current);
    packagesDb.findByIdForUpdate.mockResolvedValue(current);
    packagesDb.findPrimaryPublishedByProfileIdForUpdate.mockResolvedValue(
      current
    );
    return service.unpublishPackage(
      current.id,
      {
        expected_current_package_id: current.id,
        expected_current_package_hash: current.package_hash
      },
      ownerContext()
    );
  },
  archivePackage: ({ service, packagesDb }, onLock) => {
    const entity = createEntity({
      status: ProfileCmsPackageStatus.SUPERSEDED,
      production_valid: true
    });
    packagesDb.findById.mockResolvedValue(entity);
    // Archive locks the package row first.
    packagesDb.findByIdForUpdate.mockImplementation(async () => {
      onLock();
      return entity;
    });
    return service.archivePackage(
      entity.id,
      { expected_package_hash: entity.package_hash },
      ownerContext()
    );
  }
};

const WRITE_NAMES = Object.keys(WRITES) as (keyof typeof WRITES)[];

describe('a profile site write admitted before the identity freeze that commits after it', () => {
  let clock: ReturnType<typeof freezeClock>;
  const originalArweaveKey = process.env.ARWEAVE_KEY;
  beforeEach(() => {
    process.env.ARWEAVE_KEY = 'configured-for-test';
    clock = freezeClock();
  });
  afterEach(() => {
    clock.restore();
    jest.restoreAllMocks();
    if (originalArweaveKey === undefined) delete process.env.ARWEAVE_KEY;
    else process.env.ARWEAVE_KEY = originalArweaveKey;
  });

  it.each(WRITE_NAMES)(
    '%s is refused at COMMIT with the profile site freeze 423 and rolls back',
    async (name) => {
      const onLock = () => clock.pass();
      const fixture = setup(onLock);
      const { error } = await settle(WRITES[name](fixture, onLock));

      expect(error).toBeInstanceOf(CustomApiCompliantException);
      const refused = error as CustomApiCompliantException;
      expect(refused.getStatusCode()).toBe(423);
      expect(fixture.tx.statements).toContain('BEGIN');
      expect(fixture.tx.statements).not.toContain('COMMIT');
      expect(fixture.tx.statements.slice(-2)).toEqual(['ROLLBACK', 'RELEASE']);

      // The same answer the first check gives the same write after T.
      const late = setup(() => undefined);
      const { error: lateError } = await settle(
        WRITES[name](late, () => undefined)
      );
      expect(apiCompliantErrorBody(refused)).toEqual(
        apiCompliantErrorBody(lateError as CustomApiCompliantException)
      );
      expect(apiCompliantErrorBody(refused)).toMatchObject({
        code: 'IDENTITY_FROZEN'
      });
      expect(late.tx.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
    }
  );

  it('publish does the whole publish in the transaction before it is refused', async () => {
    const onLock = () => clock.pass();
    const fixture = setup(onLock);
    await settle(WRITES.publish(fixture, onLock));
    expect(fixture.packagesDb.markPublished).toHaveBeenCalledWith(
      'cms-package-id',
      PROFILE_CMS_FIXTURE_PROFILE_ID,
      expect.objectContaining({ valid: true }),
      expect.any(Number),
      expect.objectContaining({
        connection: expect.objectContaining({
          connection: fixture.tx.connection
        })
      })
    );
  });

  it.each(WRITE_NAMES)('%s commits when it ends before T', async (name) => {
    const fixture = setup(() => undefined);
    await WRITES[name](fixture, () => undefined);
    expectCommitted(fixture.tx.statements);
  });
});

describe('profile site writes with no freeze setting at all', () => {
  let restore: () => void;
  const originalArweaveKey = process.env.ARWEAVE_KEY;
  beforeEach(() => {
    process.env.ARWEAVE_KEY = 'configured-for-test';
    restore = clearFreezeSettings();
  });
  afterEach(() => {
    restore();
    jest.restoreAllMocks();
    if (originalArweaveKey === undefined) delete process.env.ARWEAVE_KEY;
    else process.env.ARWEAVE_KEY = originalArweaveKey;
  });

  it('assertNotFrozenAtCommit registers nothing, even inside a transaction', () => {
    const { service } = setup(() => undefined);
    const handle = {};
    openAfterCommitScope(handle);
    (service as any).assertNotFrozenAtCommit({ connection: handle });
    // Had a check been registered, it would refuse now.
    process.env.FEATURE_IDENTITY_FROZEN = 'true';
    expect(() => runBeforeCommitChecks(handle)).not.toThrow();
    closeAfterCommitScope(handle);
  });

  it.each(WRITE_NAMES)(
    '%s commits as before, with no check at COMMIT',
    async (name) => {
      // A freeze switched on while the write holds its lock does not stop
      // it: nothing was registered.
      const onLock = () => {
        process.env.FEATURE_IDENTITY_FROZEN = 'true';
      };
      const fixture = setup(onLock);
      await WRITES[name](fixture, onLock);
      expect(fixture.tx.statements).toEqual(['BEGIN', 'COMMIT', 'RELEASE']);
    }
  );
});
