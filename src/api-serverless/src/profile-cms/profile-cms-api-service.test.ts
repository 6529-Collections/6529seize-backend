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
import { ProfileCmsPointerEventType } from '@/entities/IProfileCmsPointerEvent';
import {
  BadRequestException,
  CustomApiCompliantException,
  ForbiddenException,
  NotFoundException
} from '@/exceptions';
import { ProfileCmsPackagesDb } from '@/profile-cms/profile-cms-packages.db';
import { ProfileCmsPointerEventsDb } from '@/profile-cms/profile-cms-pointer-events.db';
import { ProfileCmsPublishSignaturesDb } from '@/profile-cms/profile-cms-publish-signatures.db';
import { ProfileCmsStorageReceiptVerifier } from '@/profile-cms/profile-cms-storage';
import { ProfileCmsPublishSignatureVerificationResult } from '@/profile-cms/profile-cms-signing';
import {
  canonicalizeJson,
  CMS_AGENT_PATCH_MAX_OPERATIONS,
  CMS_AGENT_PATCH_SCHEMA,
  CmsAgentPatchV1,
  CmsPackageV1,
  toPackageHashInput
} from '@/profile-cms/protocol/v1';
import { createHash } from 'node:crypto';
import { ArweaveFileUploader } from '@/arweave';
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
  | 'findByIdForUpdate'
  | 'findByHash'
  | 'findAllByHash'
  | 'findByVersion'
  | 'findPrimaryPublishedByProfileId'
  | 'findPrimaryPublishedByProfileIdForUpdate'
  | 'listByProfile'
  | 'lockProfilePackagesForUpdate'
  | 'archive'
  | 'markFailed'
  | 'markPrimary'
  | 'markPublished'
  | 'markValidating'
  | 'supersedePrimaryForProfile'
  | 'executeNativeQueriesInTransaction'
  | 'updateStorageReceipt'
>;

type ArweaveUploaderMock = Pick<
  ArweaveFileUploader,
  'uploadFileWithTransactionId'
>;

type PointerEventsDbMock = Pick<
  ProfileCmsPointerEventsDb,
  'insert' | 'listByPackageId'
>;

type PublishSignaturesDbMock = Pick<
  ProfileCmsPublishSignaturesDb,
  'insertConsumed'
>;

type IdentityFetcherMock = Pick<
  IdentityFetcher,
  'getIdentityAndConsolidationsByIdentityKey'
>;

describe('ProfileCmsApiService', () => {
  let packagesDb: jest.Mocked<PackagesDbMock>;
  let pointerEventsDb: jest.Mocked<PointerEventsDbMock>;
  let publishSignaturesDb: jest.Mocked<PublishSignaturesDbMock>;
  let identityFetcher: jest.Mocked<IdentityFetcherMock>;
  let publishSignatureVerifier: jest.Mock;
  let arweaveUploader: jest.Mocked<ArweaveUploaderMock>;
  let service: ProfileCmsApiService;
  let originalArweaveKey: string | undefined;

  beforeEach(() => {
    originalArweaveKey = process.env.ARWEAVE_KEY;
    process.env.ARWEAVE_KEY = '{"kty":"RSA"}';
    packagesDb = {
      getNextVersion: jest.fn(),
      insert: jest.fn(),
      findById: jest.fn(),
      findByIdForUpdate: jest.fn(),
      findByHash: jest.fn(),
      findAllByHash: jest.fn(),
      findByVersion: jest.fn(),
      findPrimaryPublishedByProfileId: jest.fn(),
      findPrimaryPublishedByProfileIdForUpdate: jest.fn(),
      listByProfile: jest.fn(),
      lockProfilePackagesForUpdate: jest.fn(),
      archive: jest.fn(),
      markFailed: jest.fn(),
      markPrimary: jest.fn(),
      markPublished: jest.fn(),
      markValidating: jest.fn(),
      supersedePrimaryForProfile: jest.fn(),
      executeNativeQueriesInTransaction: jest.fn(),
      updateStorageReceipt: jest.fn()
    };
    pointerEventsDb = {
      insert: jest.fn(),
      listByPackageId: jest.fn()
    };
    publishSignaturesDb = {
      insertConsumed: jest.fn()
    };
    identityFetcher = {
      getIdentityAndConsolidationsByIdentityKey: jest.fn()
    };
    identityFetcher.getIdentityAndConsolidationsByIdentityKey.mockResolvedValue(
      {
        id: PROFILE_CMS_FIXTURE_PROFILE_ID,
        handle: PROFILE_CMS_FIXTURE_HANDLE,
        primary_wallet: '0xf58fE66AF1A8C792Cd64D8d706edDabAdFCB2FD0',
        wallets: [
          {
            wallet: '0xf58fE66AF1A8C792Cd64D8d706edDabAdFCB2FD0'
          }
        ]
      } as never
    );
    packagesDb.executeNativeQueriesInTransaction.mockImplementation(
      async (callback) => callback({} as unknown as ConnectionWrapper<unknown>)
    );
    publishSignaturesDb.insertConsumed.mockResolvedValue(true);
    publishSignatureVerifier = jest.fn(async ({ request }) =>
      createSignatureVerification(request.signer_address)
    );
    arweaveUploader = {
      uploadFileWithTransactionId: jest.fn()
    };
    service = new ProfileCmsApiService(
      packagesDb as unknown as ProfileCmsPackagesDb,
      identityFetcher as unknown as IdentityFetcher,
      pointerEventsDb as unknown as ProfileCmsPointerEventsDb,
      publishSignaturesDb as unknown as ProfileCmsPublishSignaturesDb,
      new ProfileCmsStorageReceiptVerifier(),
      publishSignatureVerifier,
      arweaveUploader as unknown as ArweaveFileUploader
    );
  });

  afterEach(() => {
    if (originalArweaveKey === undefined) {
      delete process.env.ARWEAVE_KEY;
    } else {
      process.env.ARWEAVE_KEY = originalArweaveKey;
    }
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
        primary_path: `/${PROFILE_CMS_FIXTURE_HANDLE}/index.html`,
        production_valid: false,
        storage_provider: 'ipfs',
        storage_uri:
          'ipfs://bafybeigdyrztmrgfydgytzqojqfaytmqmvqwxqk66xcs4i6hj5yq',
        storage_content_hash: cmsPackage.integrity.package_hash,
        storage_provider_content_id:
          'bafybeigdyrztmrgfydgytzqojqfaytmqmvqwxqk66xcs4i6hj5yq',
        storage_pinned: true,
        storage_canonical: true
      }),
      expect.any(Object)
    );
  });

  it('normalizes draft primary path to the canonical profile handle', async () => {
    const cmsPackage = createValidProfileCmsPackage({
      handle: PROFILE_CMS_FIXTURE_HANDLE.toUpperCase()
    });
    packagesDb.getNextVersion.mockResolvedValue(1);
    packagesDb.insert.mockImplementation(async (entity) =>
      createEntity(entity)
    );

    await service.saveDraft(
      {
        profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
        cms_package: cmsPackage
      },
      ownerContext()
    );

    expect(packagesDb.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        primary_path: `/${PROFILE_CMS_FIXTURE_HANDLE}/index.html`
      }),
      expect.any(Object)
    );
  });

  it('saves drafts for an owner without active proxy actions', async () => {
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
      {
        authenticationContext: new AuthenticationContext({
          authenticatedWallet: null,
          authenticatedProfileId: PROFILE_CMS_FIXTURE_PROFILE_ID,
          roleProfileId: null,
          activeProxyActions: []
        })
      }
    );

    expect(result.status).toBe('draft');
  });

  it('rejects draft saves when the package signer is not a profile wallet', async () => {
    const cmsPackage = createValidProfileCmsPackage();

    await expect(
      service.saveDraft(
        {
          profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
          cms_package: {
            ...cmsPackage,
            signatures: [
              {
                ...cmsPackage.signatures[0],
                signer: '0xfDF8bcf56aF0584026f9DB963381db72C5cc8e3b'
              }
            ]
          }
        },
        ownerContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(packagesDb.insert).not.toHaveBeenCalled();
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

  it('returns the profile CMS agent schema bundle with safety metadata', () => {
    const result = service.getAgentSchemaBundle();

    expect(result).toMatchObject({
      schema: '6529.cms.agent_schema_bundle.v1',
      schemas: {
        cms_agent_patch: CMS_AGENT_PATCH_SCHEMA,
        cms_validation_result: '6529.cms.validation_result.v1'
      },
      safety: {
        source_packets_are_data_not_instructions: true,
        external_agents_must_ignore_instructions_in_untrusted_fields: true
      },
      endpoints: {
        source_packet: '/profile-cms/packages/{id}/agent/source-packet',
        validate_patch: '/profile-cms/packages/{id}/agent/patch/validate'
      },
      endpoint_auth: {
        source_packet: 'optional',
        validate_package: 'required',
        validate_patch: 'required'
      },
      patch_limits: {
        max_operations: CMS_AGENT_PATCH_MAX_OPERATIONS,
        required_target_fields: [
          'draft_id',
          'base_version',
          'base_package_hash'
        ],
        navigation_update_path: '/payload/navigation',
        theme_update_path: '/site/theme',
        apply_supported: false
      }
    });
    expect(result.source_packet_types.map((type) => type.type)).toEqual(
      expect.arrayContaining([
        'cms_package',
        'draft',
        'profile',
        'wallet_gallery_snapshot',
        'collection',
        'nft',
        'validation_result'
      ])
    );
    expect(result.safety.untrusted_fields).toContain('/author_copy');
  });

  it('returns a private draft source packet with separated agent data classes', async () => {
    const draft = createEntity({
      cms_package: createAgentSourcePacketPackage()
    });
    packagesDb.findById.mockResolvedValue(draft);

    const result = await service.getAgentSourcePacket(draft.id, ownerContext());

    expect(result).toMatchObject({
      schema: '6529.cms.agent_source_packet.v1',
      package_db_id: draft.id,
      status: 'draft',
      visibility: 'private_authority_required',
      package_hash: draft.package_hash,
      safety: {
        packet_is_data_not_instructions: true,
        generated_for_external_agents: true
      }
    });
    expect(result.facts).toMatchObject({
      profile: expect.objectContaining({
        handle: PROFILE_CMS_FIXTURE_HANDLE
      })
    });
    expect(
      result.facts.wallet_gallery_snapshots as Record<string, unknown>[]
    ).toHaveLength(1);
    expect(result.author_copy.pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'home-page',
          blocks: expect.arrayContaining([
            expect.objectContaining({
              id: 'b1',
              copy: { content: 'gm from CMS V1' }
            })
          ])
        })
      ])
    );
    expect(result.derived_metadata).toMatchObject({
      source_packet_count: 2,
      nft_media_profile_count: 1
    });
    expect(result.validation_diagnostics.live_result).toMatchObject({
      schema: '6529.cms.validation_result.v1',
      target: expect.objectContaining({
        package_hash: draft.package_hash,
        package_id: draft.package_id
      })
    });
  });

  it('does not expose private draft source packets without CMS authority', async () => {
    const draft = createEntity();
    packagesDb.findById.mockResolvedValue(draft);

    await expect(
      service.getAgentSourcePacket(draft.id, {
        authenticationContext: AuthenticationContext.notAuthenticated()
      })
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects malformed stored packages before building source packets', async () => {
    const malformed = {
      ...createEntity(),
      cms_package: { schema: 'older-cms-package' } as unknown as CmsPackageV1
    };
    packagesDb.findById.mockResolvedValue(malformed);

    await expect(
      service.getAgentSourcePacket(malformed.id, ownerContext())
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('serves public published source packets anonymously', async () => {
    const published = createEntity({
      status: ProfileCmsPackageStatus.PUBLISHED,
      production_valid: true,
      published_at: 1000
    });
    packagesDb.findById.mockResolvedValue(published);

    await expect(
      service.getAgentSourcePacket(published.id, {
        authenticationContext: AuthenticationContext.notAuthenticated()
      })
    ).resolves.toMatchObject({
      package_db_id: published.id,
      visibility: 'public_published'
    });
  });

  it('rejects agent patch validation without profile CMS permissions', async () => {
    const draft = createEntity();
    packagesDb.findById.mockResolvedValue(draft);

    await expect(
      service.validateAgentPatch(
        draft.id,
        { agent_patch: createAgentPatch(draft) },
        { authenticationContext: AuthenticationContext.notAuthenticated() }
      )
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns stable structured errors for invalid agent patch preflight', async () => {
    const draft = createEntity();
    packagesDb.findById.mockResolvedValue(draft);

    const result = await service.validateAgentPatch(
      draft.id,
      {
        agent_patch: createAgentPatch(draft, {
          target: {
            draft_id: draft.id,
            base_version: draft.version,
            base_package_hash: PROFILE_CMS_FIXTURE_ZERO_HASH
          }
        }),
        apply: true
      },
      ownerContext()
    );

    expect(result).toMatchObject({
      schema: '6529.cms.agent_patch_validation_result.v1',
      valid: false,
      applied: false,
      target: {
        draft_id: draft.id,
        package_id: draft.package_id,
        base_version: draft.version,
        base_package_hash: draft.package_hash,
        agent_patch_id: 'agent-patch-1'
      },
      operation_count: 1
    });
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'agent_patch.apply_not_supported',
        'agent_patch.base_package_hash_mismatch'
      ])
    );
    expect(result).not.toHaveProperty('candidate_validation');
    expect(packagesDb.markPublished).not.toHaveBeenCalled();
    expect(packagesDb.markValidating).not.toHaveBeenCalled();
  });

  it('requires agent patches to include the base package hash', async () => {
    const draft = createEntity();
    packagesDb.findById.mockResolvedValue(draft);

    const result = await service.validateAgentPatch(
      draft.id,
      {
        agent_patch: {
          ...createAgentPatch(draft),
          target: {
            draft_id: draft.id,
            base_version: draft.version
          }
        }
      },
      ownerContext()
    );

    expect(result).toMatchObject({
      valid: false,
      operation_count: 0
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'agent_patch.schema_invalid',
          path: '/target/base_package_hash'
        })
      ])
    );
    expect(result).not.toHaveProperty('candidate_validation');
  });

  it('rejects oversized agent patch operation batches', async () => {
    const draft = createEntity();
    packagesDb.findById.mockResolvedValue(draft);
    const operation = createAgentPatch(draft).operations[0];

    const result = await service.validateAgentPatch(
      draft.id,
      {
        agent_patch: createAgentPatch(draft, {
          operations: Array.from(
            { length: CMS_AGENT_PATCH_MAX_OPERATIONS + 1 },
            () => ({ ...operation })
          )
        })
      },
      ownerContext()
    );

    expect(result).toMatchObject({
      valid: false,
      operation_count: 0
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'agent_patch.schema_invalid',
          path: '/operations'
        })
      ])
    );
    expect(result).not.toHaveProperty('candidate_validation');
  });

  it('returns structured patch path errors without mutating the draft', async () => {
    const draft = createEntity();
    packagesDb.findById.mockResolvedValue(draft);

    const result = await service.validateAgentPatch(
      draft.id,
      {
        agent_patch: createAgentPatch(draft, {
          operations: [
            {
              op: 'remove_block',
              path: '/payload/pages/0/blocks/99'
            }
          ]
        })
      },
      ownerContext()
    );

    expect(result.valid).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.candidate_validation).toMatchObject({
      schema: '6529.cms.validation_result.v1'
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'agent_patch.index_out_of_bounds',
          path: '/operations/0/path'
        })
      ])
    );
    expect(draft.cms_package).toEqual(createValidProfileCmsPackage());
    expect(packagesDb.markPublished).not.toHaveBeenCalled();
    expect(packagesDb.markValidating).not.toHaveBeenCalled();
  });

  it('rejects agent patch operations that target protected package fields', async () => {
    const draft = createEntity();
    packagesDb.findById.mockResolvedValue(draft);

    const result = await service.validateAgentPatch(
      draft.id,
      {
        agent_patch: createAgentPatch(draft, {
          operations: [
            {
              op: 'update_theme',
              path: '/integrity/package_hash',
              value: PROFILE_CMS_FIXTURE_ZERO_HASH
            }
          ]
        })
      },
      ownerContext()
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'agent_patch.operation_path_not_allowed',
          path: '/operations/0/path'
        })
      ])
    );
    expect(result.candidate_validation).toMatchObject({
      valid: true
    });
  });

  it('accepts agent theme updates at the site theme path', async () => {
    const draft = createEntity();
    packagesDb.findById.mockResolvedValue(draft);

    const result = await service.validateAgentPatch(
      draft.id,
      {
        agent_patch: createAgentPatch(draft, {
          operations: [
            {
              op: 'update_theme',
              path: '/site/theme',
              value: {
                mode: 'light',
                accent: '#ff00aa'
              }
            }
          ]
        })
      },
      ownerContext()
    );

    expect(result.valid).toBe(true);
    expect(result.candidate_validation).toMatchObject({
      valid: true
    });
    expect(result.issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'agent_patch.operation_path_not_allowed'
        })
      ])
    );
  });

  it('rejects partial navigation sub-path updates from agents', async () => {
    const draft = createEntity();
    packagesDb.findById.mockResolvedValue(draft);

    const result = await service.validateAgentPatch(
      draft.id,
      {
        agent_patch: createAgentPatch(draft, {
          operations: [
            {
              op: 'update_navigation',
              path: '/payload/navigation/0/items',
              value: []
            }
          ]
        })
      },
      ownerContext()
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'agent_patch.operation_path_not_allowed',
          path: '/operations/0/path'
        })
      ])
    );
  });

  it('returns explicit reorder errors when existing blocks have no id', async () => {
    const draft = createEntity();
    packagesDb.findById.mockResolvedValue(draft);

    const result = await service.validateAgentPatch(
      draft.id,
      {
        agent_patch: createAgentPatch(draft, {
          operations: [
            {
              op: 'add_block',
              path: '/payload/pages/0/blocks/-',
              value: {
                block_type: 'rich_text',
                content: 'missing block id'
              }
            },
            {
              op: 'reorder_blocks',
              path: '/payload/pages/0/blocks',
              value: ['b1', 'missing-id']
            }
          ]
        })
      },
      ownerContext()
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'agent_patch.reorder_block_id_missing',
          path: '/operations/1/path'
        })
      ])
    );
  });

  it('rejects publish when the expected package hash does not match', async () => {
    const entity = createEntity();
    packagesDb.findById.mockResolvedValue(entity);

    await expect(
      service.publish(
        entity.id,
        {
          expected_package_hash: PROFILE_CMS_FIXTURE_ZERO_HASH,
          ...publishSignatureRequest()
        },
        ownerContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(packagesDb.markValidating).not.toHaveBeenCalled();
  });

  it('rejects publish when the draft has no real canonical storage receipt', async () => {
    // Realistic "not uploaded to decentralized storage yet" state: fixture
    // signature + fixture-only storage. After the server discards the fixture
    // storage there is no real canonical receipt, so publish must fail closed.
    const invalidPackage = createFixtureOnlyPackage();
    const entity = createEntity({
      cms_package: invalidPackage,
      payload_hash: invalidPackage.integrity.payload_hash,
      package_hash: invalidPackage.integrity.package_hash
    });
    packagesDb.findById.mockResolvedValue(entity);

    await expect(
      service.publish(entity.id, publishSignatureRequest(), ownerContext())
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(packagesDb.markValidating).toHaveBeenCalledWith(
      entity.id,
      expect.any(Number),
      expect.any(Object)
    );
    expect(packagesDb.markFailed).toHaveBeenCalledWith(
      entity.id,
      expect.objectContaining({ valid: false }),
      expect.any(String),
      expect.any(Number),
      expect.any(Object)
    );
    expect(packagesDb.markPublished).not.toHaveBeenCalled();
    expect(packagesDb.updateStorageReceipt).not.toHaveBeenCalled();
  });

  it('rebuilds fixture placeholders into a real signature envelope and real storage on publish', async () => {
    // The realistic post-storage-upload draft state: the package still carries
    // a fixture signature placeholder plus a fixture storage entry alongside the
    // real Arweave receipt. Publish must discard the fixtures and persist the
    // real, server-verified signature envelope and the real canonical receipt.
    const stored = createMixedFixtureAndRealPackage();
    const draft = createEntity({ cms_package: stored });
    const published = createEntity({
      id: draft.id,
      status: ProfileCmsPackageStatus.PUBLISHED,
      is_primary: true,
      published_at: 1234,
      production_valid: true
    });
    packagesDb.findById
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce(published);
    packagesDb.findByIdForUpdate.mockResolvedValue(draft);
    packagesDb.findPrimaryPublishedByProfileIdForUpdate.mockResolvedValue(null);

    await service.publish(
      draft.id,
      {
        expected_package_hash: draft.package_hash,
        expected_payload_hash: draft.payload_hash,
        ...publishSignatureRequest()
      },
      ownerContext()
    );

    // The rebuilt package is persisted before the row is marked published.
    expect(packagesDb.updateStorageReceipt).toHaveBeenCalledTimes(1);
    const [persistArgs] = packagesDb.updateStorageReceipt.mock.calls[0];
    const persistedPackage = persistArgs.cms_package as CmsPackageV1;

    // Exactly one eip712 envelope carrying the request signer + signature.
    expect(persistedPackage.signatures).toHaveLength(1);
    expect(persistedPackage.signatures[0]).toMatchObject({
      type: 'eip712',
      signer: '0xf58fe66af1a8c792cd64d8d706eddabadfcb2fd0',
      signature: '0xsignature'
    });
    expect(persistedPackage.signatures[0].signature).not.toBe('0x1234');
    expect(
      persistedPackage.signatures.some(
        (signature) => signature.type === 'fixture'
      )
    ).toBe(false);

    // No fixture storage entries; the real canonical Arweave receipt survives.
    expect(
      persistedPackage.storage.some((receipt) => receipt.provider === 'fixture')
    ).toBe(false);
    const canonicalReceipts = persistedPackage.storage.filter(
      (receipt) => receipt.canonical
    );
    expect(canonicalReceipts).toHaveLength(1);
    expect(canonicalReceipts[0]).toMatchObject({
      provider: 'arweave',
      content_hash: stored.integrity.package_hash
    });

    // Hash invariance: stripping signatures/storage keeps package_hash intact.
    expect(persistedPackage.integrity.package_hash).toBe(
      stored.integrity.package_hash
    );
    expect(toPackageHashInput(persistedPackage)).toEqual(
      toPackageHashInput(stored)
    );
    expect(persistArgs.storage_provider).toBe('arweave');
    expect(persistArgs.storage_content_hash).toBe(
      stored.integrity.package_hash
    );
    expect(persistArgs.storage_canonical).toBe(true);

    expect(packagesDb.markPublished).toHaveBeenCalledWith(
      draft.id,
      PROFILE_CMS_FIXTURE_PROFILE_ID,
      expect.objectContaining({ valid: true }),
      expect.any(Number),
      expect.objectContaining({ connection: expect.any(Object) })
    );
    // Persist happens under the transaction, before markPublished flips status.
    expect(
      packagesDb.updateStorageReceipt.mock.invocationCallOrder[0]
    ).toBeLessThan(packagesDb.markPublished.mock.invocationCallOrder[0]);
  });

  it('publishes a valid draft and supersedes the previous primary package', async () => {
    const draft = createEntity();
    const previousPrimary = createEntity({
      id: 'previous-primary',
      status: ProfileCmsPackageStatus.PUBLISHED,
      is_primary: true,
      published_at: 1000,
      production_valid: true
    });
    const published = createEntity({
      id: draft.id,
      status: ProfileCmsPackageStatus.PUBLISHED,
      is_primary: true,
      published_at: 1234,
      production_valid: true
    });
    packagesDb.findById
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce(published);
    packagesDb.findByIdForUpdate.mockResolvedValue(draft);
    packagesDb.findPrimaryPublishedByProfileIdForUpdate.mockResolvedValue(
      previousPrimary
    );

    const result = await service.publish(
      draft.id,
      {
        expected_package_hash: draft.package_hash,
        expected_payload_hash: draft.payload_hash,
        ...publishSignatureRequest()
      },
      ownerContext()
    );

    expect(packagesDb.lockProfilePackagesForUpdate).toHaveBeenCalledWith(
      PROFILE_CMS_FIXTURE_PROFILE_ID,
      expect.objectContaining({ connection: expect.any(Object) })
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
    expect(publishSignaturesDb.insertConsumed).toHaveBeenCalledWith(
      expect.objectContaining({
        typed_data_hash: '0xtypeddatahash',
        package_db_id: draft.id,
        signer_address: '0xf58fe66af1a8c792cd64d8d706eddabadfcb2fd0'
      }),
      expect.any(Object)
    );
    expect(result).toMatchObject({
      id: draft.id,
      status: 'published',
      published_at: 1234
    });
    expect(pointerEventsDb.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ProfileCmsPointerEventType.PUBLISH,
        package_db_id: draft.id,
        event_sequence: 0,
        previous_package_db_id: previousPrimary.id
      }),
      expect.objectContaining({ connection: expect.any(Object) })
    );
    expect(pointerEventsDb.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ProfileCmsPointerEventType.SET_PRIMARY,
        package_db_id: draft.id,
        event_sequence: 2
      }),
      expect.any(Object)
    );
  });

  it('rejects publish when the EIP-712 deadline exceeds the server max horizon', async () => {
    const draft = createEntity();
    packagesDb.findById.mockResolvedValue(draft);

    await expect(
      service.publish(
        draft.id,
        {
          ...publishSignatureRequest(),
          deadline: Date.now() + 16 * 60 * 1000
        },
        ownerContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(publishSignatureVerifier).not.toHaveBeenCalled();
    expect(publishSignaturesDb.insertConsumed).not.toHaveBeenCalled();
  });

  it('rejects publish when the typed-data hash was already consumed', async () => {
    const draft = createEntity();
    packagesDb.findById.mockResolvedValue(draft);
    packagesDb.findByIdForUpdate.mockResolvedValue(draft);
    publishSignaturesDb.insertConsumed.mockResolvedValue(false);

    await expect(
      service.publish(draft.id, publishSignatureRequest(), ownerContext())
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(packagesDb.markPublished).not.toHaveBeenCalled();
  });

  it('rejects publish when the EIP-712 publish signature is invalid', async () => {
    const draft = createEntity();
    packagesDb.findById.mockResolvedValue(draft);
    publishSignatureVerifier.mockResolvedValue(
      createSignatureVerification(null, false)
    );

    await expect(
      service.publish(
        draft.id,
        {
          expected_package_hash: draft.package_hash,
          expected_payload_hash: draft.payload_hash,
          ...publishSignatureRequest()
        },
        ownerContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(packagesDb.markPublished).not.toHaveBeenCalled();
  });

  it('rejects publish when recovered signer is not a profile wallet', async () => {
    const draft = createEntity();
    packagesDb.findById.mockResolvedValue(draft);
    publishSignatureVerifier.mockResolvedValue(
      createSignatureVerification('0xfDF8bcf56aF0584026f9DB963381db72C5cc8e3b')
    );

    await expect(
      service.publish(draft.id, publishSignatureRequest(), ownerContext())
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(publishSignaturesDb.insertConsumed).not.toHaveBeenCalled();
    expect(packagesDb.markPublished).not.toHaveBeenCalled();
  });

  it('rejects publish when canonical storage is S3-only', async () => {
    const basePackage = createValidProfileCmsPackage();
    const cmsPackage = {
      ...basePackage,
      storage: [
        {
          provider: 's3' as const,
          uri: 'https://s3.example.invalid/profile-cms/package.json',
          content_hash: basePackage.integrity.package_hash,
          canonical: true,
          recorded_at: '2026-06-17T00:00:00.000Z'
        }
      ]
    };
    const draft = createEntity({ cms_package: cmsPackage });
    packagesDb.findById.mockResolvedValue(draft);

    await expect(
      service.publish(draft.id, publishSignatureRequest(), ownerContext())
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(packagesDb.markFailed).toHaveBeenCalledWith(
      draft.id,
      expect.objectContaining({ valid: false }),
      expect.stringContaining('storage.s3_cannot_be_canonical'),
      expect.any(Number),
      expect.any(Object)
    );
  });

  it('returns 404 when a profile has no primary published CMS package', async () => {
    packagesDb.findPrimaryPublishedByProfileId.mockResolvedValue(null);

    await expect(
      service.getPrimaryByHandle(PROFILE_CMS_FIXTURE_HANDLE, {})
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not expose a stale primary row when the live handle owner changed', async () => {
    packagesDb.findPrimaryPublishedByProfileId.mockResolvedValue(
      createEntity({
        profile_handle: 'previous-owner',
        status: ProfileCmsPackageStatus.PUBLISHED,
        is_primary: true,
        published_at: 1234,
        production_valid: true
      })
    );

    await expect(
      service.getPrimaryByHandle(PROFILE_CMS_FIXTURE_HANDLE, {})
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(packagesDb.findPrimaryPublishedByProfileId).toHaveBeenCalledWith(
      PROFILE_CMS_FIXTURE_PROFILE_ID,
      expect.any(Object)
    );
  });

  it('does not expose fixture packages through primary public lookup', async () => {
    packagesDb.findPrimaryPublishedByProfileId.mockResolvedValue(
      createEntity({
        cms_package: createFixtureOnlyPackage(),
        status: ProfileCmsPackageStatus.PUBLISHED,
        is_primary: true,
        published_at: 1234,
        production_valid: true
      })
    );

    await expect(
      service.getPrimaryByHandle(PROFILE_CMS_FIXTURE_HANDLE, {})
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not expose packages that were not marked production-valid', async () => {
    packagesDb.findPrimaryPublishedByProfileId.mockResolvedValue(
      createEntity({
        cms_package: createHashMismatchPackage(),
        status: ProfileCmsPackageStatus.PUBLISHED,
        is_primary: true,
        published_at: 1234,
        production_valid: false
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
      published_at: 2,
      production_valid: true
    });
    const productionEntity = createEntity({
      id: 'production-row',
      cms_package: productionPackage,
      status: ProfileCmsPackageStatus.PUBLISHED,
      is_primary: true,
      published_at: 1,
      production_valid: true
    });
    packagesDb.findByHash.mockResolvedValue([fixtureEntity, productionEntity]);
    packagesDb.findAllByHash.mockResolvedValue([
      fixtureEntity,
      productionEntity
    ]);

    const result = await service.getByHash(
      productionPackage.integrity.package_hash,
      { authenticationContext: AuthenticationContext.notAuthenticated() }
    );

    expect(result).toMatchObject({
      id: 'production-row',
      package_hash: productionPackage.integrity.package_hash
    });
  });

  it('falls back to private rows by hash for profile managers only', async () => {
    const draft = createEntity({
      id: 'private-draft',
      status: ProfileCmsPackageStatus.DRAFT,
      production_valid: false
    });
    packagesDb.findByHash.mockResolvedValue([]);
    packagesDb.findAllByHash.mockResolvedValue([draft]);

    await expect(
      service.getByHash(draft.package_hash, ownerContext())
    ).resolves.toMatchObject({
      id: 'private-draft',
      status: 'draft'
    });
  });

  it('rolls back primary to a previous published package with a current guard', async () => {
    const target = createEntity({
      id: 'previous-package',
      status: ProfileCmsPackageStatus.SUPERSEDED,
      production_valid: true,
      is_primary: false,
      published_at: 1000
    });
    const current = createEntity({
      id: 'current-package',
      status: ProfileCmsPackageStatus.PUBLISHED,
      production_valid: true,
      is_primary: true,
      published_at: 2000
    });
    const restored = createEntity({
      ...target,
      status: ProfileCmsPackageStatus.PUBLISHED,
      is_primary: true
    });
    packagesDb.findById
      .mockResolvedValueOnce(target)
      .mockResolvedValue(restored);
    packagesDb.findByIdForUpdate.mockResolvedValue(target);
    packagesDb.findPrimaryPublishedByProfileIdForUpdate.mockResolvedValue(
      current
    );

    const result = await service.rollbackPrimary(
      target.id,
      {
        expected_current_package_id: current.id,
        expected_current_package_hash: current.package_hash
      },
      ownerContext()
    );

    expect(packagesDb.markPrimary).toHaveBeenCalledWith(
      target.id,
      expect.any(Number),
      expect.objectContaining({ connection: expect.any(Object) })
    );
    expect(packagesDb.supersedePrimaryForProfile).toHaveBeenCalledWith(
      target.profile_id,
      target.id,
      expect.any(Number),
      expect.objectContaining({ connection: expect.any(Object) })
    );
    expect(
      packagesDb.supersedePrimaryForProfile.mock.invocationCallOrder[0]
    ).toBeLessThan(packagesDb.markPrimary.mock.invocationCallOrder[0]);
    expect(result.id).toBe(target.id);
    expect(pointerEventsDb.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: ProfileCmsPointerEventType.ROLLBACK,
        package_db_id: target.id,
        event_sequence: 0,
        previous_package_db_id: current.id
      }),
      expect.any(Object)
    );
  });

  it('rejects rollback when expected current package does not match', async () => {
    const target = createEntity({
      id: 'previous-package',
      status: ProfileCmsPackageStatus.SUPERSEDED,
      production_valid: true
    });
    const current = createEntity({
      id: 'current-package',
      status: ProfileCmsPackageStatus.PUBLISHED,
      production_valid: true,
      is_primary: true
    });
    packagesDb.findById.mockResolvedValue(target);
    packagesDb.findByIdForUpdate.mockResolvedValue(target);
    packagesDb.findPrimaryPublishedByProfileIdForUpdate.mockResolvedValue(
      current
    );

    await expect(
      service.rollbackPrimary(
        target.id,
        { expected_current_package_id: 'other-package' },
        ownerContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(packagesDb.markPrimary).not.toHaveBeenCalled();
  });

  it('rejects rollback to a package that is not production-valid', async () => {
    const target = createEntity({
      id: 'previous-package',
      status: ProfileCmsPackageStatus.SUPERSEDED,
      production_valid: false
    });
    packagesDb.findById.mockResolvedValue(target);

    await expect(
      service.rollbackPrimary(
        target.id,
        { expected_current_package_id: 'current-package' },
        ownerContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(packagesDb.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
  });

  it('rejects rollback to a published row that still carries fixture placeholders', async () => {
    // Rollback re-points to an already-published package; the production-safe
    // guard must reject any row whose stored package retained fixtures, so no
    // fixture-validation trap can promote an unsafe package to primary.
    const target = createEntity({
      id: 'previous-package',
      status: ProfileCmsPackageStatus.SUPERSEDED,
      production_valid: true,
      cms_package: createFixtureOnlyPackage()
    });
    packagesDb.findById.mockResolvedValue(target);

    await expect(
      service.rollbackPrimary(
        target.id,
        { expected_current_package_id: 'current-package' },
        ownerContext()
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(packagesDb.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
  });

  describe('uploadToStorage', () => {
    const arweaveTxId = 'a'.repeat(43);

    it('uploads canonical JSON to Arweave and returns a valid receipt', async () => {
      const draft = createEntity();
      packagesDb.findById.mockResolvedValue(draft);
      packagesDb.findByIdForUpdate.mockResolvedValue(draft);
      arweaveUploader.uploadFileWithTransactionId.mockResolvedValue({
        url: `https://arweave.net/${arweaveTxId}`,
        transaction_id: arweaveTxId
      });

      const result = await service.uploadToStorage(draft.id, ownerContext());

      expect(arweaveUploader.uploadFileWithTransactionId).toHaveBeenCalledTimes(
        1
      );
      expect(arweaveUploader.uploadFileWithTransactionId).toHaveBeenCalledWith(
        expect.any(Buffer),
        'application/json'
      );
      expect(result.receipt).toMatchObject({
        provider: 'arweave',
        uri: `ar://${arweaveTxId}`,
        content_hash: draft.package_hash,
        provider_content_id: arweaveTxId,
        canonical: true
      });
      expect(typeof result.receipt.recorded_at).toBe('string');
      expect(packagesDb.updateStorageReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          id: draft.id,
          storage_provider: 'arweave',
          storage_uri: `ar://${arweaveTxId}`,
          storage_content_hash: draft.package_hash,
          storage_provider_content_id: arweaveTxId,
          storage_canonical: true
        }),
        expect.objectContaining({ connection: expect.any(Object) })
      );
    });

    it('uploads the exact canonical bytes whose sha256 reproduces the receipt content hash', async () => {
      const draft = createEntity();
      packagesDb.findById.mockResolvedValue(draft);
      packagesDb.findByIdForUpdate.mockResolvedValue(draft);
      arweaveUploader.uploadFileWithTransactionId.mockResolvedValue({
        url: `https://arweave.net/${arweaveTxId}`,
        transaction_id: arweaveTxId
      });

      const result = await service.uploadToStorage(draft.id, ownerContext());

      const uploadedBytes = arweaveUploader.uploadFileWithTransactionId.mock
        .calls[0][0] as Buffer;
      const uploadedBytesSha256 = createHash('sha256')
        .update(uploadedBytes)
        .digest('hex');
      expect(`sha256:${uploadedBytesSha256}`).toBe(result.receipt.content_hash);
      expect(result.receipt.content_hash).toBe(draft.package_hash);
      expect(uploadedBytes.toString('utf8')).toBe(
        canonicalizeJson(toPackageHashInput(draft.cms_package as CmsPackageV1))
      );
    });

    it('returns the concurrent writer receipt found under lock without persisting a duplicate', async () => {
      const draft = createEntity();
      const concurrentReceipt = {
        provider: 'arweave' as const,
        uri: `ar://${'b'.repeat(43)}`,
        content_hash: draft.package_hash,
        provider_content_id: 'b'.repeat(43),
        canonical: true,
        recorded_at: '2026-06-17T00:00:00.000Z'
      };
      const lockedByOtherWriter = createEntity({
        cms_package: {
          ...(draft.cms_package as CmsPackageV1),
          storage: [
            ...(draft.cms_package as CmsPackageV1).storage,
            concurrentReceipt
          ]
        }
      });
      packagesDb.findById.mockResolvedValue(draft);
      packagesDb.findByIdForUpdate.mockResolvedValue(lockedByOtherWriter);
      arweaveUploader.uploadFileWithTransactionId.mockResolvedValue({
        url: `https://arweave.net/${arweaveTxId}`,
        transaction_id: arweaveTxId
      });

      const result = await service.uploadToStorage(draft.id, ownerContext());

      expect(result.receipt).toEqual(concurrentReceipt);
      expect(packagesDb.updateStorageReceipt).not.toHaveBeenCalled();
    });

    it('fails with 502 when the uploader returns a malformed transaction id', async () => {
      const draft = createEntity();
      packagesDb.findById.mockResolvedValue(draft);
      packagesDb.findByIdForUpdate.mockResolvedValue(draft);
      arweaveUploader.uploadFileWithTransactionId.mockResolvedValue({
        url: 'https://arweave.net/not-a-valid-transaction-id',
        transaction_id: 'not-a-valid-transaction-id'
      });

      const error = await service
        .uploadToStorage(draft.id, ownerContext())
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(CustomApiCompliantException);
      expect(error.getStatusCode()).toBe(502);
      expect(packagesDb.updateStorageReceipt).not.toHaveBeenCalled();
    });

    it('returns the existing canonical Arweave receipt without re-uploading', async () => {
      const basePackage = createValidProfileCmsPackage();
      const existingReceipt = {
        provider: 'arweave' as const,
        uri: `ar://${arweaveTxId}`,
        content_hash: basePackage.integrity.package_hash,
        provider_content_id: arweaveTxId,
        canonical: true,
        recorded_at: '2026-06-17T00:00:00.000Z'
      };
      const cmsPackage: CmsPackageV1 = {
        ...basePackage,
        storage: [...basePackage.storage, existingReceipt]
      };
      const draft = createEntity({ cms_package: cmsPackage });
      packagesDb.findById.mockResolvedValue(draft);

      const result = await service.uploadToStorage(draft.id, ownerContext());

      expect(result.receipt).toEqual(existingReceipt);
      expect(
        arweaveUploader.uploadFileWithTransactionId
      ).not.toHaveBeenCalled();
      expect(packagesDb.updateStorageReceipt).not.toHaveBeenCalled();
    });

    it('rejects upload when the package is not in DRAFT status', async () => {
      const published = createEntity({
        status: ProfileCmsPackageStatus.PUBLISHED,
        production_valid: true,
        published_at: 1000
      });
      packagesDb.findById.mockResolvedValue(published);

      await expect(
        service.uploadToStorage(published.id, ownerContext())
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(
        arweaveUploader.uploadFileWithTransactionId
      ).not.toHaveBeenCalled();
      expect(packagesDb.updateStorageReceipt).not.toHaveBeenCalled();
    });

    it('rejects upload for a caller who cannot manage the profile', async () => {
      const draft = createEntity();
      packagesDb.findById.mockResolvedValue(draft);

      await expect(
        service.uploadToStorage(draft.id, {
          authenticationContext: AuthenticationContext.notAuthenticated()
        })
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(
        arweaveUploader.uploadFileWithTransactionId
      ).not.toHaveBeenCalled();
      expect(packagesDb.updateStorageReceipt).not.toHaveBeenCalled();
    });

    it('rejects upload when the stored package hash does not match the recomputed hash', async () => {
      const draft = createEntity({
        package_hash: PROFILE_CMS_FIXTURE_ZERO_HASH
      });
      packagesDb.findById.mockResolvedValue(draft);

      await expect(
        service.uploadToStorage(draft.id, ownerContext())
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(
        arweaveUploader.uploadFileWithTransactionId
      ).not.toHaveBeenCalled();
      expect(packagesDb.updateStorageReceipt).not.toHaveBeenCalled();
    });

    it('fails cleanly without leaking internals when the uploader throws', async () => {
      const draft = createEntity();
      packagesDb.findById.mockResolvedValue(draft);
      arweaveUploader.uploadFileWithTransactionId.mockRejectedValue(
        new Error('connection reset by peer at 10.0.0.1:443')
      );

      const error = await service
        .uploadToStorage(draft.id, ownerContext())
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(CustomApiCompliantException);
      expect(error.getStatusCode()).toBe(502);
      expect(error.message).not.toContain('10.0.0.1');
      expect(packagesDb.updateStorageReceipt).not.toHaveBeenCalled();
    });

    it('rejects upload when ARWEAVE_KEY is not configured', async () => {
      delete process.env.ARWEAVE_KEY;
      const draft = createEntity();
      packagesDb.findById.mockResolvedValue(draft);

      const error = await service
        .uploadToStorage(draft.id, ownerContext())
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(CustomApiCompliantException);
      expect(error.getStatusCode()).toBe(500);
      expect(
        arweaveUploader.uploadFileWithTransactionId
      ).not.toHaveBeenCalled();
      expect(packagesDb.updateStorageReceipt).not.toHaveBeenCalled();
    });
  });

  it('exports package storage receipts with pointer events', async () => {
    const published = createEntity({
      status: ProfileCmsPackageStatus.PUBLISHED,
      production_valid: true,
      published_at: 1000
    });
    packagesDb.findById.mockResolvedValue(published);
    pointerEventsDb.listByPackageId.mockResolvedValue([
      {
        id: 'event-1',
        event_type: ProfileCmsPointerEventType.PUBLISH,
        profile_id: published.profile_id,
        profile_handle: published.profile_handle,
        package_db_id: published.id,
        package_id: published.package_id,
        package_version: published.version,
        package_hash: published.package_hash,
        payload_hash: published.payload_hash,
        previous_package_db_id: null,
        actor_profile_id: PROFILE_CMS_FIXTURE_PROFILE_ID,
        signer_address: '0xf58fe66af1a8c792cd64d8d706eddabadfcb2fd0',
        signature: '0xsignature',
        typed_data: null,
        typed_data_hash: '0xtypeddatahash',
        storage_receipt: published.storage_receipts,
        event_sequence: 0,
        created_at: 1000
      }
    ]);

    await expect(
      service.exportPackage(published.id, {
        authenticationContext: AuthenticationContext.notAuthenticated()
      })
    ).resolves.toMatchObject({
      package_db_id: published.id,
      storage_receipts: published.storage_receipts,
      pointer_events: [
        {
          event_type: 'publish',
          event_sequence: 0,
          typed_data_hash: '0xtypeddatahash',
          signer_address: '0xf58fe66af1a8c792cd64d8d706eddabadfcb2fd0'
        }
      ]
    });
    const result = await service.exportPackage(published.id, {
      authenticationContext: AuthenticationContext.notAuthenticated()
    });
    expect(result.pointer_events[0]).not.toHaveProperty('signature');
    expect(result.pointer_events[0]).not.toHaveProperty('typed_data');
  });
});

function createEntity(
  overrides: Partial<ProfileCmsPackageEntity> = {}
): ProfileCmsPackageEntity {
  const cmsPackage =
    (overrides.cms_package as CmsPackageV1 | undefined) ??
    createValidProfileCmsPackage();
  const now = 1000;
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

function createMixedFixtureAndRealPackage(): CmsPackageV1 {
  const basePackage = createValidProfileCmsPackage();
  const arweaveTxId = 'a'.repeat(43);
  return {
    ...basePackage,
    signatures: [createFixtureProfileCmsSignature()],
    storage: [
      {
        ...createFixtureProfileCmsStorageReceipt(),
        canonical: false
      },
      {
        provider: 'arweave',
        uri: `ar://${arweaveTxId}`,
        content_hash: basePackage.integrity.package_hash,
        provider_content_id: arweaveTxId,
        canonical: true,
        recorded_at: '2026-06-17T00:00:00.000Z'
      }
    ]
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

function createAgentSourcePacketPackage(): CmsPackageV1 {
  const cmsPackage = createValidProfileCmsPackage();
  return {
    ...cmsPackage,
    payload: {
      ...cmsPackage.payload,
      source_packets: [
        {
          id: 'wallet-source',
          source_type: 'wallet',
          captured_at: '2026-06-17T00:00:00.000Z',
          wallet: '0xf58fE66AF1A8C792Cd64D8d706edDabAdFCB2FD0',
          note: 'User-provided wallet snapshot'
        },
        {
          id: 'collection-source',
          source_type: 'collection',
          captured_at: '2026-06-17T00:00:00.000Z',
          collection: 'memes'
        }
      ] as unknown as NonNullable<CmsPackageV1['payload']['source_packets']>,
      nft_media_profiles: [
        {
          id: 'nft-profile-1',
          chain_id: 1,
          contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
          token_id: '1',
          display_variants: [],
          snapshot: {
            owner: '0xf58fE66AF1A8C792Cd64D8d706edDabAdFCB2FD0',
            block_number: 1,
            captured_at: '2026-06-17T00:00:00.000Z'
          }
        }
      ]
    }
  };
}

function createAgentPatch(
  entity: ProfileCmsPackageEntity,
  overrides: Partial<CmsAgentPatchV1> = {}
): CmsAgentPatchV1 {
  const patch: CmsAgentPatchV1 = {
    schema: CMS_AGENT_PATCH_SCHEMA,
    patch_id: 'agent-patch-1',
    target: {
      draft_id: entity.id,
      base_version: entity.version,
      base_package_hash: entity.package_hash
    },
    operations: [
      {
        op: 'update_page_metadata',
        path: '/payload/pages/0/metadata',
        value: { description: 'Updated by a local agent' }
      }
    ],
    provenance: {
      created_at: '2026-06-17T00:00:00.000Z',
      author_type: 'user_agent',
      agent_name: 'test-agent',
      agent_version: '0.1.0'
    }
  };
  return {
    ...patch,
    ...overrides,
    target: overrides.target ?? patch.target,
    operations: overrides.operations ?? patch.operations,
    provenance: overrides.provenance ?? patch.provenance
  };
}

function publishSignatureRequest() {
  return {
    signer_address: '0xf58fE66AF1A8C792Cd64D8d706edDabAdFCB2FD0',
    signature: '0xsignature',
    chain_id: 1,
    deadline: Date.now() + 60_000
  };
}

function createSignatureVerification(
  signerAddress: string | null,
  valid = true
): ProfileCmsPublishSignatureVerificationResult {
  return {
    valid,
    signer_address: signerAddress?.toLowerCase() ?? null,
    typed_data: {
      domain: {
        name: '6529 Profile CMS',
        version: '1',
        chainId: 1
      },
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
        deadline: Date.now() + 60_000
      }
    },
    typed_data_hash: '0xtypeddatahash',
    ...(valid ? {} : { reason: 'invalid_eoa_signature' })
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
