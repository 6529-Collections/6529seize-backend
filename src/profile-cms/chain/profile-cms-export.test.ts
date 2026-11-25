import { createHash } from 'node:crypto';
import { CmsPublishedPackageRow, CmsSiteRow } from '@/api/cms/cms.db';
import {
  ProfileCmsPackageEntity,
  ProfileCmsPackageStatus
} from '@/entities/IProfileCmsPackage';
import {
  ProfileCmsPointerEventEntity,
  ProfileCmsPointerEventType
} from '@/entities/IProfileCmsPointerEvent';
import {
  LEGACY_SIGNATURE_FORMS,
  readProfileCmsArchive
} from '@/profile-cms/chain/profile-cms-archive';
import {
  cmsCidMatchesBytes,
  cmsHashFromCid
} from '@/profile-cms/chain/profile-cms-cid';
import {
  ProfileCmsExportEntry,
  ProfileCmsExporter,
  ProfileCmsExportSource,
  snapshotCmsValue
} from '@/profile-cms/chain/profile-cms-export';
import {
  checkLegacyCmsSignature,
  legacySignedMessages
} from '@/profile-cms/chain/profile-cms-legacy-signature';
import { checkProfileCmsPublication } from '@/profile-cms/chain/profile-cms-publication-check';
import {
  ProfileDocCms,
  readProfileDocCms
} from '@/profile-cms/chain/profile-doc-cms';
import { buildProfileCmsPublishTypedData } from '@/profile-cms/profile-cms-signing';
import {
  aLegacyPackage,
  aSignedProfileSite,
  CHAIN_FIXTURE_OTHER_WALLET,
  CHAIN_FIXTURE_PROFILE_ID,
  CHAIN_FIXTURE_SAFE,
  CHAIN_FIXTURE_WALLET,
  SignedSiteFixture
} from '@/tests/fixtures/profile-cms-chain.fixture';

const WALLET = CHAIN_FIXTURE_WALLET.address.toLowerCase();
const T = Date.parse('2026-11-24T00:00:00.000Z');

/**
 * The imported ProfileDoc's profile site, read as the index reads it: the
 * keys the identity snapshot builder writes from this profile's
 * cms-fields.json value (build.rs: `archive` to `cms.archive`, `primary`'s
 * `package` and `publication` to `cms.primary.package` and
 * `cms.primary.publication`).
 */
function readImportedDoc(entry: ProfileCmsExportEntry) {
  const value = (entry.cms ? snapshotCmsValue(entry.cms) : {}) as {
    primary?: { publication: string; package: string };
    archive?: string;
  };
  const fields: Record<string, string> = {};
  if (value.archive) fields['cms.archive'] = value.archive;
  if (value.primary) {
    fields['cms.primary.package'] = value.primary.package;
    fields['cms.primary.publication'] = value.primary.publication;
  }
  return readProfileDocCms(fields);
}

function row(
  site: SignedSiteFixture,
  overrides: Partial<ProfileCmsPackageEntity>
): ProfileCmsPackageEntity {
  return {
    id: site.draftId,
    profile_id: CHAIN_FIXTURE_PROFILE_ID,
    profile_handle: 'testhandle',
    package_id: site.cmsPackage.package_id,
    version: 1,
    status: ProfileCmsPackageStatus.PUBLISHED,
    cms_package: site.cmsPackage,
    payload_hash: site.cmsPackage.integrity.payload_hash,
    package_hash: site.packageHash,
    primary_path: '/testhandle/index.html',
    is_primary: true,
    production_valid: true,
    created_by_profile_id: CHAIN_FIXTURE_PROFILE_ID,
    published_by_profile_id: CHAIN_FIXTURE_PROFILE_ID,
    created_at: 1,
    updated_at: 2,
    validated_at: 2,
    published_at: 2,
    failed_at: null,
    archived_at: null,
    superseded_by_id: null,
    validation_result: null,
    validation_error: null,
    storage_receipts: site.cmsPackage.storage,
    storage_provider: 'arweave',
    storage_uri: `ar://${'a'.repeat(43)}`,
    storage_content_hash: site.packageHash,
    storage_provider_content_id: null,
    storage_recorded_at: '2026-11-20T00:00:00.000Z',
    storage_pinned: null,
    storage_canonical: true,
    recovery_receipt: null,
    publication_cid: null,
    ...overrides
  };
}

function publishEvent(site: SignedSiteFixture): ProfileCmsPointerEventEntity {
  const publication = JSON.parse(site.publicationBytes.toString());
  return {
    id: `event-${site.draftId}`,
    event_type: ProfileCmsPointerEventType.PUBLISH,
    profile_id: CHAIN_FIXTURE_PROFILE_ID,
    profile_handle: 'testhandle',
    package_db_id: site.draftId,
    package_id: site.cmsPackage.package_id,
    package_version: 1,
    package_hash: site.packageHash,
    payload_hash: site.cmsPackage.integrity.payload_hash,
    previous_package_db_id: null,
    actor_profile_id: CHAIN_FIXTURE_PROFILE_ID,
    signer_address: WALLET,
    signature: publication.signature,
    typed_data: buildProfileCmsPublishTypedData({
      request: {
        signer_address: WALLET,
        signature: '',
        chain_id: 1,
        deadline: publication.typed_data.message.deadline
      },
      message: publication.typed_data.message
    }),
    typed_data_hash: site.typedDataHash,
    storage_receipt: site.cmsPackage.storage[0],
    event_sequence: 0,
    created_at: 2
  };
}

function storedReceipt(site: SignedSiteFixture) {
  return {
    provider: 'arweave',
    uri: `ar://${'b'.repeat(43)}`,
    content_hash: `sha256:${createHash('sha256').update(site.publicationBytes).digest('hex')}`
  };
}

function legacyRow(
  siteId: string,
  legacy: ReturnType<typeof aLegacyPackage>
): CmsPublishedPackageRow {
  return {
    package_hash: legacy.packageHash,
    payload_hash: legacy.payloadHash,
    schema: '6529.cms.payload.v1',
    site_id: siteId,
    owner_profile_id: CHAIN_FIXTURE_PROFILE_ID,
    title: siteId,
    description: null,
    static_path: `/${siteId}`,
    canonical_url: null,
    package_json: legacy.packageJson,
    storage_json: legacy.storage,
    signature_json: legacy.signatureJson,
    published_at: 3,
    published_by_wallet: WALLET
  };
}

function legacySite(id: string, primaryHash: string | null): CmsSiteRow {
  return {
    id,
    owner_profile_id: CHAIN_FIXTURE_PROFILE_ID,
    slug: id,
    title: id,
    description: null,
    primary_package_hash: primaryHash,
    primary_static_path: primaryHash ? `/${id}` : null,
    created_at: 1,
    updated_at: 1,
    created_by_wallet: WALLET,
    updated_by_wallet: null
  };
}

function source(
  overrides: Partial<ProfileCmsExportSource>
): ProfileCmsExportSource {
  return {
    handle: 'testhandle',
    wallets: [WALLET],
    packages: [],
    events: [],
    signatures: [],
    legacySites: [],
    legacyPackages: [],
    ...overrides
  };
}

describe('ProfileCmsExporter', () => {
  const site = aSignedProfileSite({ draftId: 'draft-1' });

  it('carries the stored publication record when its receipt still serves it', async () => {
    const receipt = storedReceipt(site);
    const fetched: string[] = [];
    const exporter = new ProfileCmsExporter(async (asked) => {
      fetched.push(asked.uri);
      return site.publicationBytes;
    });
    const entry = await exporter.exportProfile(
      CHAIN_FIXTURE_PROFILE_ID,
      source({ packages: [row(site, { recovery_receipt: receipt })] }),
      T
    );
    expect(fetched).toEqual([receipt.uri]);
    const cms = readImportedDoc(entry);
    expect(cms.ok && cms.cms?.primary).toEqual({
      publication: site.publicationCid,
      package: site.coreCid
    });
    expect(entry.report).toMatchObject({
      rebuilt_publications: [],
      publication_unavailable: [],
      primary_carried: true,
      primary_refused: null
    });
    for (const file of entry.files) {
      expect(cmsCidMatchesBytes(file.cid, file.bytes)).toBe(true);
    }
  });

  it('never replaces a stored record it can not fetch, and says so', async () => {
    const entry = await new ProfileCmsExporter(async () => null).exportProfile(
      CHAIN_FIXTURE_PROFILE_ID,
      source({
        packages: [row(site, { recovery_receipt: storedReceipt(site) })],
        events: [publishEvent(site)]
      }),
      T
    );
    expect(entry.report).toMatchObject({
      publication_unavailable: ['draft-1'],
      rebuilt_publications: [],
      primary_carried: false,
      primary_refused: 'no_publication_record'
    });
  });

  it('rebuilds a publication record from the publish event, and it verifies', async () => {
    const exporter = new ProfileCmsExporter(async () => null);
    const entry = await exporter.exportProfile(
      CHAIN_FIXTURE_PROFILE_ID,
      source({ packages: [row(site, {})], events: [publishEvent(site)] }),
      T
    );
    expect(entry.report.rebuilt_publications).toEqual(['draft-1']);
    expect(entry.report.rebuilt_refused).toEqual([]);
    expect(entry.report.primary_refused).toBeNull();
    const cms = readImportedDoc(entry);
    if (!cms.ok || !cms.cms?.primary) throw new Error('no primary');
    const files = new Map(entry.files.map((file) => [file.cid, file.bytes]));
    const check = await checkProfileCmsPublication({
      primary: cms.cms.primary,
      publicationBytes: files.get(cms.cms.primary.publication) ?? null,
      packageBytes: files.get(cms.cms.primary.package) ?? null,
      profileId: CHAIN_FIXTURE_PROFILE_ID,
      wallets: [WALLET],
      checkedAtMs: T
    });
    expect(check.ok).toBe(true);
    const archive = readProfileCmsArchive(
      files.get(cms.cms.archive as string) as Buffer
    );
    expect(archive.ok && archive.archive.packages[0]).toMatchObject({
      id: 'draft-1',
      package: site.coreCid,
      publication: cms.cms.primary.publication,
      publication_rebuilt: true
    });
    expect(archive.ok && archive.archive.pointer_events).toHaveLength(1);
  });

  it('reports a rebuilt record the reader refuses, and keeps it in history', async () => {
    const forged = {
      ...publishEvent(site),
      signature: `0x${'1b'.repeat(65)}`
    };
    const noSafe = () => ({
      hasContractCode: async () => false,
      isValidSignature: async () => false
    });
    const entry = await new ProfileCmsExporter(
      async () => null,
      noSafe
    ).exportProfile(
      CHAIN_FIXTURE_PROFILE_ID,
      source({ packages: [row(site, {})], events: [forged] }),
      T
    );
    expect(entry.report.rebuilt_publications).toEqual(['draft-1']);
    expect(entry.report.rebuilt_refused).toEqual([
      { id: 'draft-1', reason: expect.stringMatching(/^signature_/) }
    ]);
    expect(entry.report.packages).toBe(1);
  });

  it('gives the same bytes on a second run', async () => {
    const run = () =>
      new ProfileCmsExporter(async () => null).exportProfile(
        CHAIN_FIXTURE_PROFILE_ID,
        source({ packages: [row(site, {})], events: [publishEvent(site)] }),
        T
      );
    const [first, second] = [await run(), await run()];
    expect(second.files).toEqual(first.files);
    expect(second.cms).toEqual(first.cms);
  });

  it("does not carry a primary the reader's check refuses", async () => {
    const forged = {
      ...publishEvent(site),
      signature: `0x${'1b'.repeat(65)}`
    };
    const noSafe = () => ({
      hasContractCode: async () => false,
      isValidSignature: async () => false
    });
    const entry = await new ProfileCmsExporter(
      async () => null,
      noSafe
    ).exportProfile(
      CHAIN_FIXTURE_PROFILE_ID,
      source({ packages: [row(site, {})], events: [forged] }),
      T
    );
    expect(entry.report.primary_carried).toBe(false);
    expect(entry.report.primary_refused).toMatch(/^signature_/);
    expect(Object.keys(snapshotCmsValue(entry.cms as ProfileDocCms))).toEqual([
      'archive'
    ]);
  });

  it('carries a Safe-signed primary only if the Safe still accepts it at T', async () => {
    const safeSite = aSignedProfileSite({
      draftId: 'draft-safe',
      safe: CHAIN_FIXTURE_SAFE
    });
    const asked: number[] = [];
    // The Safe's owners changed after the publish: it accepts the signature
    // at the publish's block and not at T's.
    const safeAt = (timeMs: number) => ({
      hasContractCode: async () => true,
      isValidSignature: async () => {
        asked.push(timeMs);
        return timeMs < T;
      }
    });
    const exporter = new ProfileCmsExporter(
      async () => safeSite.publicationBytes,
      safeAt
    );
    const entry = await exporter.exportProfile(
      CHAIN_FIXTURE_PROFILE_ID,
      source({
        wallets: [WALLET, CHAIN_FIXTURE_SAFE],
        packages: [
          row(safeSite, {
            recovery_receipt: storedReceipt(safeSite),
            published_at: T - 1_000
          })
        ]
      }),
      T
    );
    expect(asked.sort((left, right) => left - right)).toEqual([T - 1_000, T]);
    expect(entry.report).toMatchObject({
      primary: 'draft-safe',
      primary_carried: false,
      primary_refused: 'signature_invalid_eip1271_signature',
      primary_refused_at_publish: null
    });
    expect(readImportedDoc(entry)).toMatchObject({
      ok: true,
      cms: { primary: null }
    });
  });

  it('picks the primary the API serves: the latest published', async () => {
    const older = row(
      aSignedProfileSite({ draftId: 'draft-1', title: 'Old' }),
      {
        published_at: 5,
        updated_at: 5
      }
    );
    const newerSite = aSignedProfileSite({
      draftId: 'draft-2',
      version: 2,
      title: 'New'
    });
    const newer = {
      ...row(newerSite, { published_at: 9, updated_at: 9 }),
      version: 2
    };
    const entry = await new ProfileCmsExporter(async () => null).exportProfile(
      CHAIN_FIXTURE_PROFILE_ID,
      source({
        packages: [older, newer],
        events: [
          publishEvent(
            aSignedProfileSite({ draftId: 'draft-1', title: 'Old' })
          ),
          publishEvent(newerSite)
        ]
      }),
      T
    );
    expect(entry.report.primary).toBe('draft-2');
  });

  it('keeps a primary without any publication record out of the field, and says so', async () => {
    const entry = await new ProfileCmsExporter(async () => null).exportProfile(
      CHAIN_FIXTURE_PROFILE_ID,
      source({ packages: [row(site, {})] }),
      T
    );
    expect(entry.report).toMatchObject({
      primary: 'draft-1',
      primary_carried: false,
      primary_refused: 'no_publication_record',
      without_publication: ['draft-1']
    });
    expect(Object.keys(snapshotCmsValue(entry.cms as ProfileDocCms))).toEqual([
      'archive'
    ]);
  });

  it('reports a package whose stored content no longer matches its hash', async () => {
    const entry = await new ProfileCmsExporter(async () => null).exportProfile(
      CHAIN_FIXTURE_PROFILE_ID,
      source({
        packages: [row(site, { package_hash: `sha256:${'f'.repeat(64)}` })]
      }),
      T
    );
    expect(entry.report.bad_core).toEqual(['draft-1']);
    expect(entry.cms).toBeNull();
  });

  it('leaves drafts and never-published legacy sites out', async () => {
    const entry = await new ProfileCmsExporter(async () => null).exportProfile(
      CHAIN_FIXTURE_PROFILE_ID,
      source({
        packages: [
          row(site, {
            status: ProfileCmsPackageStatus.DRAFT,
            published_at: null
          })
        ],
        legacySites: [legacySite('site-empty', null)]
      }),
      T
    );
    expect(entry.cms).toBeNull();
    expect(entry.files).toEqual([]);
  });

  it('archives legacy packages in the API shape as files with their signature result', async () => {
    const verified = aLegacyPackage({ title: 'a' });
    const unverified = aLegacyPackage({ title: 'b', badSignature: true });
    const entry = await new ProfileCmsExporter(async () => null).exportProfile(
      CHAIN_FIXTURE_PROFILE_ID,
      source({
        legacyPackages: [
          legacyRow('site-a', verified),
          legacyRow('site-b', unverified)
        ],
        legacySites: [
          legacySite('site-a', verified.packageHash),
          legacySite('site-b', unverified.packageHash)
        ]
      }),
      T
    );
    expect(entry.report.legacy_unverified).toEqual([unverified.packageHash]);
    expect(entry.report.legacy_unverified_primaries).toEqual(['site-b']);
    const cms = readImportedDoc(entry);
    const files = new Map(entry.files.map((file) => [file.cid, file.bytes]));
    const archive = readProfileCmsArchive(
      files.get((cms.ok && cms.cms?.archive) as string) as Buffer
    );
    if (!archive.ok) throw new Error(archive.reason);
    const [archivedA] = archive.archive.legacy.packages.filter(
      (legacy) => legacy.package_hash === verified.packageHash
    );
    expect(archivedA.signature_check).toEqual({
      verified: true,
      form: 'personal_sign_unsigned_hash',
      signer: WALLET
    });
    expect(cmsHashFromCid(archivedA.package_json)).not.toBeNull();
    expect(
      JSON.parse((files.get(archivedA.package_json) as Buffer).toString())
    ).toEqual(verified.packageJson);
  });
});

describe('checkLegacyCmsSignature', () => {
  it('accepts a vector computed outside this module, by one of the wallets at T only', () => {
    // The message was computed in Python (sorted-key JSON, sha256) and
    // signed with the fixture's test key by Foundry's `cast wallet sign` and
    // by eth_account, which give the same signature.
    const payloadHash =
      'sha256:b704a7994e3961f9ad228c8c3fabc07ed70538c7b1beee314aff64bc0e14e05c';
    const signatureJson = {
      signature_type: 'eip191',
      signing_wallet: WALLET,
      signed_at: '2026-11-01T00:00:00.000Z',
      signature:
        '0x86b9e92375d4b1d213e05da2dd4c32bfd736996715aaf5b870eccad9818b438c' +
        '00e5feb0b89ed9ac49c7fb1d0930ecb470cfa8bd9815364225256dbcbfe8c2c51b'
    };
    const packageJson = {
      schema: '6529.cms.payload.v1',
      payload: { title: 'vector', blocks: [{ text: 'vector' }] },
      payload_hash: payloadHash,
      storage: [{ provider: 'ipfs', uri: 'ipfs://test', pinned: true }],
      signature: signatureJson,
      // Covers the signature, so it can't be what was signed.
      package_hash: `sha256:${'0'.repeat(64)}`
    };
    const message = legacySignedMessages({ payloadHash, packageJson }).find(
      ([form]) => form === 'personal_sign_unsigned_hash'
    );
    expect(message?.[1]()).toBe(
      'sha256:6a2c0833b1e5fb656f88bc9d67991df78629014aa8a29978b073661b3dbe64ee'
    );
    const check = (ownerWallets: string[]) =>
      checkLegacyCmsSignature({
        payloadHash,
        packageJson,
        signatureJson,
        ownerWallets
      });
    expect(check([WALLET])).toEqual({
      verified: true,
      form: 'personal_sign_unsigned_hash',
      signer: WALLET
    });
    // A wallet that signed but is not the profile's at T does not count.
    expect(
      check([CHAIN_FIXTURE_OTHER_WALLET.address.toLowerCase()]).verified
    ).toBe(false);
  });

  it.each(LEGACY_SIGNATURE_FORMS)('accepts a signature of form %s', (form) => {
    const legacy = aLegacyPackage({ title: 'x', form });
    expect(
      checkLegacyCmsSignature({
        payloadHash: legacy.payloadHash,
        packageJson: legacy.packageJson,
        signatureJson: legacy.signatureJson,
        ownerWallets: [WALLET]
      })
    ).toEqual({ verified: true, form, signer: WALLET });
  });

  it('can not match a signature over package_hash, which covers the signature', () => {
    const legacy = aLegacyPackage({ title: 'x' });
    const signatureJson = {
      ...legacy.signatureJson,
      signature: CHAIN_FIXTURE_WALLET.signMessageSync(legacy.packageHash)
    };
    expect(
      checkLegacyCmsSignature({
        payloadHash: legacy.payloadHash,
        packageJson: { ...legacy.packageJson, signature: signatureJson },
        signatureJson,
        ownerWallets: [WALLET]
      }).verified
    ).toBe(false);
  });

  it("refuses a signer who is not one of the owner's wallets", () => {
    const legacy = aLegacyPackage({
      title: 'x',
      wallet: CHAIN_FIXTURE_OTHER_WALLET
    });
    expect(
      checkLegacyCmsSignature({
        payloadHash: legacy.payloadHash,
        packageJson: legacy.packageJson,
        signatureJson: legacy.signatureJson,
        ownerWallets: [WALLET]
      }).verified
    ).toBe(false);
  });

  it('refuses a signature by another wallet than the envelope names', () => {
    const legacy = aLegacyPackage({
      title: 'x',
      wallet: CHAIN_FIXTURE_OTHER_WALLET,
      signingWallet: WALLET
    });
    expect(
      checkLegacyCmsSignature({
        payloadHash: legacy.payloadHash,
        packageJson: legacy.packageJson,
        signatureJson: legacy.signatureJson,
        ownerWallets: [WALLET]
      }).verified
    ).toBe(false);
  });

  it.each([null, {}, { signing_wallet: 'x', signature: '0x00' }])(
    'refuses a malformed envelope %#',
    (signatureJson) => {
      const legacy = aLegacyPackage({ title: 'x' });
      expect(
        checkLegacyCmsSignature({
          payloadHash: legacy.payloadHash,
          packageJson: legacy.packageJson,
          signatureJson,
          ownerWallets: [WALLET]
        })
      ).toEqual({ verified: false, form: null, signer: null });
    }
  );
});
