const PROFILE = 'test-profile-1';

jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: {
    getProfileIdByIdentityKeyOrThrow: async () => 'test-profile-1'
  },
  IdentityFetcher: jest.fn()
}));

import 'reflect-metadata';
import { cmsApiService } from '@/api/cms/cms.api.service';
import { ProfileCmsApiService } from '@/api/profile-cms/profile-cms.api.service';
import {
  CMS_PUBLISHED_PACKAGES_TABLE,
  CMS_SITES_TABLE,
  PROFILE_CMS_CHAIN_HEADS_TABLE,
  PROFILE_CMS_PACKAGES_TABLE,
  PROFILE_CMS_POINTER_EVENTS_TABLE,
  PROFILE_CMS_PUBLISH_SIGNATURES_TABLE
} from '@/constants';
import { ProfileCmsPackageStatus } from '@/entities/IProfileCmsPackage';
import { ProfileCmsPointerEventType } from '@/entities/IProfileCmsPointerEvent';
import { ProfileCmsChainFollower } from '@/profile-cms/chain/profile-cms-chain-follower';
import { ProfileCmsPrivateLog } from '@/profile-cms/personal-log/profile-cms-private-log';
import {
  profileCmsPrivateEntries,
  rebuildProfileCms
} from '@/profile-cms/personal-log/profile-cms-rebuild';
import { ProfileDocCms } from '@/profile-cms/chain/profile-doc-cms';
import { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { MemoryRecordLogStore } from '@/signed-records/record-log/record-log-test-store';
import { RecordLogWriter } from '@/signed-records/record-log/record-log.service';
import {
  ProfileCmsExporter,
  profileCmsExportDb
} from '@/profile-cms/chain/profile-cms-export';
import { profileCmsPackagesDb } from '@/profile-cms/profile-cms-packages.db';
import { profileCmsPointerEventsDb } from '@/profile-cms/profile-cms-pointer-events.db';
import { profileCmsPublishSignaturesDb } from '@/profile-cms/profile-cms-publish-signatures.db';
import { buildProfileCmsPublishTypedData } from '@/profile-cms/profile-cms-signing';
import { profileCmsStorageReceiptVerifier } from '@/profile-cms/profile-cms-storage';
import { RequestContext } from '@/request.context';
import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { resetTestDatabase } from '@/tests/_setup/testDatabase';
import {
  aChainIdentity,
  aLegacyPackage,
  aProfileDoc,
  aSignedProfileSite,
  CHAIN_FIXTURE_HANDLE,
  CHAIN_FIXTURE_WALLET,
  InMemoryProfileCmsChain,
  SignedSiteFixture
} from '@/tests/fixtures/profile-cms-chain.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';

const T = Date.parse('2026-11-24T00:00:00.000Z');
const OTHER_PRINCIPAL = `0x${'0'.repeat(63)}2`;
const NO_DOC_PRINCIPAL = `0x${'0'.repeat(63)}3`;
const MARKED_PRINCIPAL = `0x${'0'.repeat(63)}4`;
const SWITCH = Date.parse('2026-11-25T00:00:00.000Z');
const WALLET = CHAIN_FIXTURE_WALLET.address.toLowerCase();
const ctx: RequestContext = { timer: undefined };

// Old path: v1 published, then v2 published (v1 superseded), v3 an unpublished draft.
const site1 = aSignedProfileSite({
  draftId: 'draft-1',
  version: 1,
  title: 'First'
});
const site2 = aSignedProfileSite({
  draftId: 'draft-2',
  version: 2,
  title: 'Second'
});
const site3 = aSignedProfileSite({
  draftId: 'draft-3',
  version: 3,
  title: 'Third'
});
const SITE2_RECEIPT = {
  provider: 'arweave',
  uri: `ar://${'b'.repeat(43)}`,
  content_hash: `sha256:${require('node:crypto')
    .createHash('sha256')
    .update(site2.publicationBytes)
    .digest('hex')}`,
  canonical: true,
  recorded_at: '2026-11-21T00:00:00.000Z'
};

function oldPathRow(
  site: SignedSiteFixture,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const receipt = site.cmsPackage.storage[0];
  return {
    id: site.draftId,
    profile_id: PROFILE,
    profile_handle: CHAIN_FIXTURE_HANDLE,
    package_id: site.cmsPackage.package_id,
    version: Number(site.draftId.slice(-1)),
    status: ProfileCmsPackageStatus.PUBLISHED,
    cms_package: site.cmsPackage,
    payload_hash: site.cmsPackage.integrity.payload_hash,
    package_hash: site.packageHash,
    primary_path: `/${CHAIN_FIXTURE_HANDLE}/index.html`,
    is_primary: true,
    production_valid: true,
    created_by_profile_id: PROFILE,
    published_by_profile_id: PROFILE,
    created_at: 500,
    updated_at: 1000,
    validated_at: 1000,
    published_at: 1000,
    failed_at: null,
    archived_at: null,
    superseded_by_id: null,
    validation_result: {
      schema: '6529.cms.validation_result.v1',
      valid: true,
      issues: []
    },
    validation_error: null,
    storage_receipts: site.cmsPackage.storage,
    storage_provider: receipt.provider,
    storage_uri: receipt.uri,
    storage_content_hash: receipt.content_hash,
    storage_provider_content_id: null,
    storage_recorded_at: receipt.recorded_at,
    storage_pinned: null,
    storage_canonical: true,
    recovery_receipt: null,
    ...overrides
  };
}

function oldPathEvent(
  id: string,
  type: ProfileCmsPointerEventType,
  site: SignedSiteFixture,
  previous: string | null,
  signedBy: SignedSiteFixture,
  sequence: number,
  createdAt: number
): Record<string, unknown> {
  const message = JSON.parse(signedBy.publicationBytes.toString()).typed_data
    .message;
  const typedData = buildProfileCmsPublishTypedData({
    request: {
      signer_address: WALLET,
      signature: '',
      chain_id: 1,
      deadline: message.deadline
    },
    message
  });
  return {
    id,
    event_type: type,
    profile_id: PROFILE,
    profile_handle: CHAIN_FIXTURE_HANDLE,
    package_db_id: site.draftId,
    package_id: site.cmsPackage.package_id,
    package_version: Number(site.draftId.slice(-1)),
    package_hash: site.packageHash,
    payload_hash: site.cmsPackage.integrity.payload_hash,
    previous_package_db_id: previous,
    actor_profile_id: PROFILE,
    signer_address: WALLET,
    signature: JSON.parse(signedBy.publicationBytes.toString()).signature,
    typed_data: typedData,
    typed_data_hash: signedBy.typedDataHash,
    storage_receipt: signedBy.cmsPackage.storage[0],
    event_sequence: sequence,
    created_at: createdAt
  };
}

// Legacy packages in the shape the legacy API accepts: the signature envelope
// and storage inside the package JSON. A is signed over its unsigned hash,
// B carries a signature that verifies under no form.
const legacyA = aLegacyPackage({ title: 'A' });
const legacyB = aLegacyPackage({ title: 'B', badSignature: true });
const legacyPackageA = legacyA.packageJson as { package_hash: string };
const legacyPackageB = legacyB.packageJson as { package_hash: string };

function legacyPackageRow(
  siteId: string,
  legacy: ReturnType<typeof aLegacyPackage>
): Record<string, unknown> {
  return {
    package_hash: legacy.packageHash,
    payload_hash: legacy.payloadHash,
    schema: '6529.cms.payload.v1',
    site_id: siteId,
    owner_profile_id: PROFILE,
    title: siteId,
    description: null,
    static_path: `/${siteId}`,
    canonical_url: null,
    package_json: legacy.packageJson,
    storage_json: legacy.storage,
    signature_json: legacy.signatureJson,
    published_at: 900,
    published_by_wallet: WALLET
  };
}

const SEEDS = [
  withIdentities([
    anIdentity(
      {},
      {
        consolidation_key: WALLET,
        profile_id: PROFILE,
        primary_address: WALLET,
        handle: CHAIN_FIXTURE_HANDLE
      }
    )
  ]),
  {
    table: PROFILE_CMS_PACKAGES_TABLE,
    rows: [
      oldPathRow(site1, {
        status: ProfileCmsPackageStatus.SUPERSEDED,
        is_primary: false,
        superseded_by_id: 'draft-2',
        updated_at: 2000
      }),
      oldPathRow(site2, {
        created_at: 1500,
        updated_at: 2000,
        validated_at: 2000,
        published_at: 2000,
        recovery_receipt: SITE2_RECEIPT
      }),
      oldPathRow(site3, {
        status: ProfileCmsPackageStatus.DRAFT,
        is_primary: false,
        production_valid: false,
        created_at: 3000,
        updated_at: 3000,
        validated_at: null,
        published_at: null,
        published_by_profile_id: null
      })
    ]
  },
  {
    table: PROFILE_CMS_POINTER_EVENTS_TABLE,
    rows: [
      oldPathEvent(
        'e1',
        ProfileCmsPointerEventType.PUBLISH,
        site1,
        null,
        site1,
        0,
        1000
      ),
      oldPathEvent(
        'e2',
        ProfileCmsPointerEventType.SET_PRIMARY,
        site1,
        null,
        site1,
        1,
        1000
      ),
      oldPathEvent(
        'e3',
        ProfileCmsPointerEventType.PUBLISH,
        site2,
        'draft-1',
        site2,
        0,
        2000
      ),
      oldPathEvent(
        'e4',
        ProfileCmsPointerEventType.SUPERSEDE,
        site1,
        'draft-2',
        site2,
        1,
        2000
      ),
      oldPathEvent(
        'e5',
        ProfileCmsPointerEventType.SET_PRIMARY,
        site2,
        'draft-1',
        site2,
        2,
        2000
      )
    ]
  },
  {
    table: PROFILE_CMS_PUBLISH_SIGNATURES_TABLE,
    rows: [site1, site2].map((site, index) => ({
      id: `sig-${index + 1}`,
      typed_data_hash: site.typedDataHash,
      profile_id: PROFILE,
      package_db_id: site.draftId,
      package_id: site.cmsPackage.package_id,
      package_version: index + 1,
      package_hash: site.packageHash,
      signer_address: WALLET,
      deadline: 1_790_000_000_000,
      created_at: (index + 1) * 1000
    }))
  },
  {
    table: CMS_SITES_TABLE,
    rows: [
      {
        id: 'site-a',
        owner_profile_id: PROFILE,
        slug: 'a',
        title: 'Site A',
        description: null,
        primary_package_hash: legacyPackageA.package_hash,
        primary_static_path: '/site-a',
        created_at: 800,
        updated_at: 950,
        created_by_wallet: WALLET,
        updated_by_wallet: WALLET
      },
      {
        id: 'site-b',
        owner_profile_id: PROFILE,
        slug: 'b',
        title: 'Site B',
        description: null,
        primary_package_hash: legacyPackageB.package_hash,
        primary_static_path: '/site-b',
        created_at: 800,
        updated_at: 900,
        created_by_wallet: WALLET,
        updated_by_wallet: WALLET
      },
      {
        id: 'site-empty',
        owner_profile_id: PROFILE,
        slug: 'empty',
        title: 'Never published',
        description: null,
        primary_package_hash: null,
        primary_static_path: null,
        created_at: 800,
        updated_at: 800,
        created_by_wallet: WALLET,
        updated_by_wallet: null
      }
    ]
  },
  {
    table: CMS_PUBLISHED_PACKAGES_TABLE,
    rows: [
      legacyPackageRow('site-a', legacyA),
      legacyPackageRow('site-b', legacyB)
    ]
  }
];

const service = new ProfileCmsApiService(
  profileCmsPackagesDb,
  {
    getIdentityAndConsolidationsByIdentityKey: async () => ({
      id: PROFILE,
      handle: CHAIN_FIXTURE_HANDLE,
      primary_wallet: WALLET,
      wallets: []
    })
  } as never,
  profileCmsPointerEventsDb,
  profileCmsPublishSignaturesDb,
  profileCmsStorageReceiptVerifier
);

async function settle(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => value,
    (error: unknown) => ({ error: (error as Error).constructor.name })
  );
}

/** Every public answer the profile site and legacy CMS routes give for this profile. */
async function publicAnswers(): Promise<Record<string, unknown>> {
  const ids = ['draft-1', 'draft-2', 'draft-3'];
  const hashes = [site1, site2, site3].map((site) => site.packageHash);
  return {
    primary: await settle(
      service.getPrimaryByHandle(CHAIN_FIXTURE_HANDLE, ctx)
    ),
    list: await settle(service.listForProfile(PROFILE, ctx)),
    byId: await Promise.all(ids.map((id) => settle(service.getById(id, ctx)))),
    exports: await Promise.all(
      ids.map((id) => settle(service.exportPackage(id, ctx)))
    ),
    byHash: await Promise.all(
      hashes.map((hash) => settle(service.getByHash(hash, ctx)))
    ),
    byVersion: await Promise.all(
      [1, 2, 3].map((version) =>
        settle(
          service.getByVersion(PROFILE, 'profile-native-home', version, ctx)
        )
      )
    ),
    legacyPrimary: await settle(
      cmsApiService.getPrimarySiteByIdentity(PROFILE, ctx)
    ),
    legacyByHash: await Promise.all(
      [legacyPackageA, legacyPackageB].map((json) =>
        settle(cmsApiService.getPackageByHash(json.package_hash))
      )
    )
  };
}

async function rows(table: string, order: string): Promise<unknown[]> {
  return sqlExecutor.execute(`select * from ${table} order by ${order}`);
}

/** Rows that public reads come from: published packages, events, signatures, legacy. */
async function indexRows(): Promise<Record<string, unknown[]>> {
  return {
    packages: (await rows(PROFILE_CMS_PACKAGES_TABLE, 'id')).filter(
      (row) => (row as { published_at: unknown }).published_at !== null
    ),
    events: await rows(PROFILE_CMS_POINTER_EVENTS_TABLE, 'id'),
    signatures: await rows(
      PROFILE_CMS_PUBLISH_SIGNATURES_TABLE,
      'typed_data_hash'
    ),
    sites: await rows(CMS_SITES_TABLE, 'id'),
    legacyPackages: await rows(CMS_PUBLISHED_PACKAGES_TABLE, 'package_hash')
  };
}

async function headRows(): Promise<unknown[]> {
  return rows(PROFILE_CMS_CHAIN_HEADS_TABLE, 'principal');
}

/** Runs the T export and puts its files and the imported ProfileDoc on a chain fixture. */
async function exportAndImport(): Promise<{
  chain: InMemoryProfileCmsChain;
  cms: ProfileDocCms | null;
  report: unknown;
}> {
  const exporter = new ProfileCmsExporter(async (receipt) =>
    receipt.uri === SITE2_RECEIPT.uri ? site2.publicationBytes : null
  );
  const entry = await exporter.exportProfile(
    PROFILE,
    await profileCmsExportDb.loadSource(PROFILE),
    T
  );
  const chain = new InMemoryProfileCmsChain();
  entry.files.forEach((file) => chain.addFile(file.bytes));
  chain.setIdentity(aChainIdentity({ profile_id: PROFILE }));
  // The import wrote at height 100, its only block: the document is the
  // one its document list names.
  chain.setIdentityImport({ start_height: 100, done_height: 100 });
  chain.replaceProfile({
    version: 1,
    height: 100,
    timeMs: SWITCH,
    doc: aProfileDoc(entry.cms),
    importDoc: true
  });
  return {
    chain,
    cms: entry.cms,
    report: entry.report
  };
}

describeWithSeed('profile sites on the chain', SEEDS, () => {
  it('exports the public history at T and names the current site', async () => {
    const { cms, report } = await exportAndImport();
    const primary = (
      cms as { primary: { publication: string; package: string } }
    ).primary;
    expect(primary).toEqual({
      publication: site2.publicationCid,
      package: site2.coreCid
    });
    expect(report).toMatchObject({
      packages: 2,
      primary: 'draft-2',
      primary_carried: true,
      rebuilt_publications: ['draft-1'],
      rebuilt_refused: [],
      without_publication: [],
      bad_core: [],
      legacy_packages: 2,
      legacy_unverified: [legacyPackageB.package_hash],
      legacy_unverified_primaries: ['site-b']
    });
  });

  it('imports at the switch without changing what 6529.io serves', async () => {
    const before = await publicAnswers();
    const { chain } = await exportAndImport();
    const follower = new ProfileCmsChainFollower(chain);
    expect(await follower.syncFrom(0, ctx)).toEqual({
      applied: 1,
      nextHeight: 101,
      waiting: 0
    });
    const after = await publicAnswers();
    // The legacy package whose signature does not verify is no longer served,
    // and package answers now carry each published package's publication CID.
    expect(withoutPublicationCid(after)).toEqual({
      ...before,
      legacyByHash: [
        (before.legacyByHash as unknown[])[0],
        { error: 'NotFoundException' }
      ]
    });
    expect(after.byId).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'draft-2',
          publication_cid: site2.publicationCid
        })
      ])
    );
    // The import fills each published row's publication CID and nothing else.
    const [first, second] = (await rows(PROFILE_CMS_PACKAGES_TABLE, 'id')) as {
      publication_cid: string | null;
    }[];
    expect(second.publication_cid).toBe(site2.publicationCid);
    expect(first.publication_cid).not.toBeNull();
  });

  it('rebuilds the same public answers and rows from empty tables', async () => {
    const before = await publicAnswers();
    const { chain } = await exportAndImport();
    const follower = new ProfileCmsChainFollower(chain);
    await follower.syncFrom(0, ctx);
    const liveRows = await indexRows();
    const liveAnswers = await publicAnswers();

    const liveHeads = await headRows();

    await resetTestDatabase();
    await new ProfileCmsChainFollower(chain).syncFrom(0, ctx);

    expect(await indexRows()).toEqual(liveRows);
    expect(await headRows()).toEqual(liveHeads);
    const rebuilt = await publicAnswers();
    expect(rebuilt).toEqual(liveAnswers);
    expect(rebuilt.primary).toEqual(before.primary);
    expect(rebuilt.legacyPrimary).toEqual(before.legacyPrimary);
  });

  it('ignores an archive a person names outside the import', async () => {
    const { cms } = await exportAndImport();
    const exporter = new ProfileCmsExporter(async () => null);
    const entry = await exporter.exportProfile(
      PROFILE,
      await profileCmsExportDb.loadSource(PROFILE),
      T
    );
    await resetTestDatabase();
    const chain = new InMemoryProfileCmsChain();
    entry.files.forEach((file) => chain.addFile(file.bytes));
    chain.setIdentityImport({ start_height: 100, done_height: 105 });
    chain.setIdentity(aChainIdentity({ profile_id: PROFILE }));
    chain.setIdentity(
      aChainIdentity({
        principal: OTHER_PRINCIPAL,
        profile_id: 'test-native-1',
        imported: false
      })
    );
    chain.setIdentity(
      aChainIdentity({
        principal: NO_DOC_PRINCIPAL,
        profile_id: 'test-imported-2',
        imported: true
      })
    );
    // An imported identity's own version 2.
    chain.replaceProfile({
      version: 1,
      height: 100,
      timeMs: SWITCH,
      doc: aProfileDoc(null)
    });
    chain.replaceProfile({
      version: 2,
      height: 110,
      timeMs: SWITCH + 10_000,
      doc: aProfileDoc({ archive: cms?.archive })
    });
    // Version 1 of an identity created on the chain.
    chain.replaceProfile({
      principal: OTHER_PRINCIPAL,
      version: 1,
      height: 120,
      timeMs: SWITCH + 20_000,
      doc: aProfileDoc({ archive: cms?.archive })
    });
    // Version 1 of an imported identity the import wrote no document for:
    // its first document is its own, after the import's heights.
    chain.replaceProfile({
      principal: NO_DOC_PRINCIPAL,
      version: 1,
      height: 130,
      timeMs: SWITCH + 30_000,
      doc: aProfileDoc({ archive: cms?.archive })
    });
    // The same, marked by the gateway as an operation inside the heights.
    chain.replaceProfile({
      principal: MARKED_PRINCIPAL,
      version: 1,
      height: 104,
      timeMs: SWITCH + 1_000,
      doc: aProfileDoc({ archive: cms?.archive }),
      source: 'operation'
    });
    chain.setIdentity(
      aChainIdentity({
        principal: MARKED_PRINCIPAL,
        profile_id: 'test-imported-3',
        imported: true
      })
    );
    expect(await new ProfileCmsChainFollower(chain).syncFrom(0, ctx)).toEqual({
      applied: 5,
      nextHeight: 131,
      waiting: 0
    });
    expect(await indexRows()).toEqual({
      packages: [],
      events: [],
      signatures: [],
      sites: [],
      legacyPackages: []
    });
  });

  it("leaves another owner's legacy rows alone when an archive names their keys", async () => {
    const { chain } = await exportAndImport();
    // Before the switch, another owner came to hold site-a's id.
    await sqlExecutor.execute(
      `update ${CMS_SITES_TABLE} set owner_profile_id = 'test-other-owner', title = 'Theirs' where id = 'site-a'`
    );
    await new ProfileCmsChainFollower(chain).syncFrom(0, ctx);
    const sites = (await rows(CMS_SITES_TABLE, 'id')) as {
      id: string;
      owner_profile_id: string;
      title: string;
    }[];
    expect(sites.find((site) => site.id === 'site-a')).toMatchObject({
      owner_profile_id: 'test-other-owner',
      title: 'Theirs'
    });
  });

  it('follows publish, rollback and unpublish, and a rebuild agrees at every height', async () => {
    const { chain, cms } = await exportAndImport();
    // The personal log takes the rows 6529.io holds when it is turned on
    // (here just before the switch), drafts included.
    const store = new MemoryRecordLogStore();
    const privateLog = new ProfileCmsPrivateLog(
      dbSupplier,
      new RecordLogWriter(store, { findGrantProofs: async () => [] }),
      { isProfileCmsPersonalLogEnabled: () => true },
      () => SWITCH - 1
    );
    // Every row of the logged tables: the packages, and the pointer events
    // and publish signatures the import brought.
    const [{ total }] = await sqlExecutor.execute<{ total: number }>(
      `select (select count(*) from ${PROFILE_CMS_PACKAGES_TABLE}) +
              (select count(*) from ${PROFILE_CMS_POINTER_EVENTS_TABLE}) +
              (select count(*) from ${PROFILE_CMS_PUBLISH_SIGNATURES_TABLE}) as total`
    );
    expect(Number(total)).toBeGreaterThan(3);
    expect(await privateLog.logExistingRows(ctx)).toBe(Number(total));
    const entries = () =>
      profileCmsPrivateEntries(
        (async function* () {
          for (const row of store.entries) {
            yield { entry: JSON.parse(row.entry) as RecordLogEntry };
          }
        })()
      );
    chain.addSite(site3);
    const archive = cms?.archive as string;
    const pointer = (site: { publicationCid: string; coreCid: string }) => ({
      primary: { publication: site.publicationCid, package: site.coreCid },
      archive
    });
    const site2Pointer = cms?.primary as {
      publication: string;
      package: string;
    };
    chain.replaceProfile({
      version: 2,
      height: 110,
      timeMs: SWITCH + 10_000,
      doc: aProfileDoc(pointer(site3))
    });
    chain.replaceProfile({
      version: 3,
      height: 120,
      timeMs: SWITCH + 20_000,
      doc: aProfileDoc({
        primary: {
          publication: site2Pointer.publication,
          package: site2Pointer.package
        },
        archive
      })
    });
    chain.replaceProfile({
      version: 4,
      height: 130,
      timeMs: SWITCH + 30_000,
      doc: aProfileDoc({ primary: null, archive })
    });
    const heights = [100, 110, 120, 130];
    const live: {
      answers: Record<string, unknown>;
      rows: Record<string, unknown[]>;
      heads: unknown[];
    }[] = [];
    for (const height of heights) {
      chain.setFinalizedHeight(height);
      await new ProfileCmsChainFollower(chain).syncFrom(0, ctx);
      live.push({
        answers: await publicAnswers(),
        rows: await indexRows(),
        heads: await headRows()
      });
    }

    expect(
      (live[1].answers.primary as { package_hash: string }).package_hash
    ).toBe(site3.packageHash);
    expect(
      (live[2].answers.primary as { package_hash: string }).package_hash
    ).toBe(site2.packageHash);
    expect(live[3].answers.primary).toEqual({ error: 'NotFoundException' });
    const chainEvents = (
      live[3].rows.events as {
        event_type: string;
        chain_height: number | null;
      }[]
    )
      .filter((event) => event.chain_height !== null)
      .map((event) => [event.chain_height, event.event_type]);
    expect(chainEvents).toEqual(
      expect.arrayContaining([
        [110, 'PUBLISH'],
        [110, 'SUPERSEDE'],
        [110, 'SET_PRIMARY'],
        [120, 'ROLLBACK'],
        [120, 'SUPERSEDE'],
        [120, 'SET_PRIMARY'],
        [130, 'UNPUBLISH']
      ])
    );
    expect(chainEvents).toHaveLength(7);

    // From empty, the chain and the personal log give every row and answer,
    // the draft fields of the package published on the chain included.
    for (let index = 0; index < heights.length; index++) {
      await resetTestDatabase();
      chain.setFinalizedHeight(heights[index]);
      await rebuildProfileCms(
        { port: chain, fromHeight: 0, privateEntries: entries() },
        ctx,
        { privateLog }
      );
      expect(await indexRows()).toEqual(live[index].rows);
      expect(await headRows()).toEqual(live[index].heads);
      expect(await publicAnswers()).toEqual(live[index].answers);
    }
    // Four rebuilds from empty: each empties every table first.
  }, 600_000);
});

function withoutPublicationCid<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, field) =>
      key === 'publication_cid' ? undefined : field
    )
  );
}
