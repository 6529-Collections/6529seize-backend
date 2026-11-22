jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: {},
  IdentityFetcher: jest.fn()
}));

import 'reflect-metadata';
import { ProfileCmsApiService } from '@/api/profile-cms/profile-cms.api.service';
import { AuthenticationContext } from '@/auth-context';
import {
  PROFILE_CMS_AGENT_EVENTS_TABLE,
  PROFILE_CMS_AGENT_GRANTS_TABLE,
  PROFILE_CMS_AGENT_PROPOSALS_TABLE,
  PROFILE_CMS_CHAIN_HEADS_TABLE,
  PROFILE_CMS_PACKAGES_TABLE,
  PROFILE_CMS_POINTER_EVENTS_TABLE,
  PROFILE_CMS_PUBLISH_SIGNATURES_TABLE
} from '@/constants';
import { ProfileCmsPackageStatus } from '@/entities/IProfileCmsPackage';
import { ProfileCmsChainFollower } from '@/profile-cms/chain/profile-cms-chain-follower';
import { ProfileCmsPrivateLog } from '@/profile-cms/personal-log/profile-cms-private-log';
import {
  profileCmsPrivateEntries,
  rebuildProfileCms
} from '@/profile-cms/personal-log/profile-cms-rebuild';
import { ProfileCmsAgentGrantsDb } from '@/profile-cms/profile-cms-agent-grants.db';
import { ProfileCmsPackagesDb } from '@/profile-cms/profile-cms-packages.db';
import { ProfileCmsPointerEventsDb } from '@/profile-cms/profile-cms-pointer-events.db';
import { RecordLogEntry } from '@/signed-records/record-log/record-log-format';
import { MemoryRecordLogStore } from '@/signed-records/record-log/record-log-test-store';
import { RecordLogWriter } from '@/signed-records/record-log/record-log.service';
import { RequestContext } from '@/request.context';
import { dbSupplier, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { resetTestDatabase } from '@/tests/_setup/testDatabase';
import {
  aChainIdentity,
  aProfileDoc,
  aSignedProfileSite,
  CHAIN_FIXTURE_HANDLE,
  CHAIN_FIXTURE_PROFILE_ID,
  InMemoryProfileCmsChain,
  SignedSiteFixture
} from '@/tests/fixtures/profile-cms-chain.fixture';

const ctx: RequestContext = { timer: undefined };
const WALLET = `0x${'0'.repeat(39)}1`;

function draftRow(site: SignedSiteFixture, createdAt: number) {
  const receipt = site.cmsPackage.storage[0];
  return {
    id: site.draftId,
    profile_id: CHAIN_FIXTURE_PROFILE_ID,
    profile_handle: CHAIN_FIXTURE_HANDLE,
    package_id: site.cmsPackage.package_id,
    version: Number(site.draftId.slice(-1)),
    status: ProfileCmsPackageStatus.DRAFT,
    cms_package: site.cmsPackage,
    payload_hash: site.cmsPackage.integrity.payload_hash,
    package_hash: site.packageHash,
    primary_path: `/${CHAIN_FIXTURE_HANDLE}/index.html`,
    is_primary: false,
    production_valid: false,
    created_by_profile_id: 'test-proxy-1',
    published_by_profile_id: null,
    created_at: createdAt,
    updated_at: createdAt,
    superseded_by_id: null,
    validation_result: null,
    validation_error: null,
    storage_receipts: site.cmsPackage.storage,
    storage_provider: receipt.provider,
    storage_uri: receipt.uri,
    storage_content_hash: receipt.content_hash,
    storage_provider_content_id: null,
    storage_recorded_at: receipt.recorded_at,
    storage_pinned: null,
    storage_canonical: true
  };
}

async function tableRows(): Promise<Record<string, unknown[]>> {
  const read = (table: string, order: string) =>
    sqlExecutor.execute(`select * from ${table} order by ${order}`);
  return {
    packages: await read(PROFILE_CMS_PACKAGES_TABLE, 'id'),
    events: await read(PROFILE_CMS_POINTER_EVENTS_TABLE, 'id'),
    signatures: await read(PROFILE_CMS_PUBLISH_SIGNATURES_TABLE, 'id'),
    heads: await read(PROFILE_CMS_CHAIN_HEADS_TABLE, 'principal'),
    grants: await read(PROFILE_CMS_AGENT_GRANTS_TABLE, 'id'),
    proposals: await read(PROFILE_CMS_AGENT_PROPOSALS_TABLE, 'id'),
    agentEvents: await read(PROFILE_CMS_AGENT_EVENTS_TABLE, 'id')
  };
}

describeWithSeed('profile site private state in the record log', [], () => {
  it('rebuilds drafts, agent records and chain publishes to the same rows', async () => {
    const store = new MemoryRecordLogStore();
    let clock = 1_000;
    const privateLog = new ProfileCmsPrivateLog(
      dbSupplier,
      new RecordLogWriter(store, { findGrantProofs: async () => [] }),
      { isProfileCmsPersonalLogEnabled: () => true },
      () => clock
    );
    const packagesDb = new ProfileCmsPackagesDb(dbSupplier, privateLog);
    const grantsDb = new ProfileCmsAgentGrantsDb(dbSupplier, privateLog);
    const site3 = aSignedProfileSite({ draftId: 'draft-3', version: 3 });
    const site4 = aSignedProfileSite({
      draftId: 'draft-4',
      version: 4,
      title: 'Fourth'
    });

    const chain = new InMemoryProfileCmsChain();
    chain.addSite(site3);
    chain.setIdentity(aChainIdentity());
    chain.replaceProfile({
      version: 1,
      height: 100,
      timeMs: 500,
      doc: aProfileDoc(null)
    });
    chain.replaceProfile({
      version: 2,
      height: 110,
      timeMs: 2_000,
      doc: aProfileDoc({
        primary: {
          publication: site3.publicationCid,
          package: site3.coreCid
        },
        archive: null
      })
    });

    // Live: drafts and agent work on 6529.io, the chain's publish, then more drafts.
    chain.setFinalizedHeight(100);
    await new ProfileCmsChainFollower(chain).syncFrom(0, ctx);
    await packagesDb.insert(draftRow(site3, 900), ctx);
    clock = 1_100;
    await packagesDb.recordPublication(
      'draft-3',
      site3.publicationCid,
      { provider: 'arweave', uri: `ar://${'c'.repeat(43)}` },
      1_100,
      ctx
    );
    clock = 1_200;
    await grantsDb.insertGrant(
      {
        id: 'grant-1',
        profile_id: CHAIN_FIXTURE_PROFILE_ID,
        draft_id: 'draft-3',
        package_id: site3.cmsPackage.package_id,
        base_version: 3,
        base_package_hash: site3.packageHash,
        issued_by_wallet: WALLET,
        token_hash: 'a'.repeat(64),
        label: 'Test agent',
        created_at: 1_200,
        expires_at: 9_000_000,
        revoked_at: null,
        request_count: 0,
        proposal_count: 0
      },
      ctx
    );
    await grantsDb.insertEvent(
      {
        id: 'agent-event-1',
        profile_id: CHAIN_FIXTURE_PROFILE_ID,
        grant_id: 'grant-1',
        proposal_id: null,
        event_type: 'issued',
        actor_wallet: WALLET,
        created_at: 1_200
      },
      ctx
    );
    clock = 1_300;
    const proposal = {
      id: 'proposal-1',
      grant_id: 'grant-1',
      profile_id: CHAIN_FIXTURE_PROFILE_ID,
      draft_id: 'draft-3',
      base_version: 3,
      base_package_hash: site3.packageHash,
      candidate_package_hash: site4.packageHash,
      idempotency_key: 'b'.repeat(36),
      request_hash: `sha256:${'c'.repeat(64)}`,
      summary: 'A change',
      created_at: 1_300,
      candidate_package: site4.cmsPackage,
      status: 'pending' as const,
      reviewed_at: null,
      result_draft_id: null,
      result_package_hash: null
    };
    await grantsDb.insertProposal(proposal, ctx);
    clock = 1_400;
    await grantsDb.recordReview(
      { ...proposal, status: 'rejected' as const, reviewed_at: 1_400 },
      ctx
    );
    chain.setFinalizedHeight(110);
    await new ProfileCmsChainFollower(chain).syncFrom(0, ctx);
    clock = 3_000;
    await packagesDb.insert(draftRow(site4, 3_000), ctx);
    clock = 3_100;
    // Archive on 6529.io's own path, as a person does after the switch: the
    // package row and its ARCHIVE pointer event.
    const service = new ProfileCmsApiService(
      packagesDb,
      {} as never,
      new ProfileCmsPointerEventsDb(dbSupplier, privateLog),
      {} as never,
      {} as never,
      jest.fn(),
      undefined,
      {} as never,
      {
        isIdentityFreezeOn: () => false,
        isProfileCmsChainPointerEnabled: () => true
      },
      () => chain
    );
    await service.archivePackage(
      'draft-4',
      { expected_package_hash: site4.packageHash },
      {
        authenticationContext: AuthenticationContext.fromProfileId(
          CHAIN_FIXTURE_PROFILE_ID
        )
      }
    );
    clock = 3_200;
    await grantsDb.revoke('grant-1', 3_200, ctx);

    const live = await tableRows();
    expect(
      (
        live.packages as { id: string; status: string; created_at: number }[]
      ).map((row) => [row.id, row.status, Number(row.created_at)])
    ).toEqual([
      ['draft-3', ProfileCmsPackageStatus.PUBLISHED, 900],
      ['draft-4', ProfileCmsPackageStatus.ARCHIVED, 3_000]
    ]);
    expect(
      (live.events as { event_type: string }[]).map((row) => row.event_type)
    ).toContain('ARCHIVE');
    expect(store.entries.every((row) => row.chain === 'private')).toBe(true);

    await resetTestDatabase();
    const walk = (async function* () {
      for (const row of store.entries) {
        yield { entry: JSON.parse(row.entry) as RecordLogEntry };
      }
    })();
    expect(
      await rebuildProfileCms(
        {
          port: chain,
          fromHeight: 0,
          privateEntries: profileCmsPrivateEntries(walk)
        },
        ctx,
        { privateLog }
      )
    ).toEqual({ changes: 2, entries: store.entries.length });

    expect(await tableRows()).toEqual(live);
  });

  it("replays a 6529.io write made between a change's block and its apply before that change", async () => {
    const store = new MemoryRecordLogStore();
    let clock = 900;
    const privateLog = new ProfileCmsPrivateLog(
      dbSupplier,
      new RecordLogWriter(store, { findGrantProofs: async () => [] }),
      { isProfileCmsPersonalLogEnabled: () => true },
      () => clock
    );
    const packagesDb = new ProfileCmsPackagesDb(dbSupplier, privateLog);
    const site = aSignedProfileSite({ draftId: 'draft-1', version: 1 });
    const chain = new InMemoryProfileCmsChain();
    chain.addSite(site);
    chain.setIdentity(aChainIdentity({ imported: false }));

    await packagesDb.insert(draftRow(site, 900), ctx);
    // PROFILE_REPLACE names the draft in a block at time 1000.
    chain.replaceProfile({
      version: 1,
      height: 10,
      timeMs: 1_000,
      doc: aProfileDoc({
        primary: { publication: site.publicationCid, package: site.coreCid },
        archive: null
      })
    });
    // Before the index applies it, 6529.io writes the draft row again.
    clock = 1_500;
    await packagesDb.recordPublication(
      'draft-1',
      site.publicationCid,
      { provider: 'arweave', uri: `ar://${'c'.repeat(43)}` },
      1_500,
      ctx
    );
    // The index applies the change later.
    await new ProfileCmsChainFollower(chain).syncFrom(0, ctx);
    const live = await tableRows();
    expect(
      (live.packages as { status: string; is_primary: unknown }[]).map(
        (row) => [row.status, Number(row.is_primary)]
      )
    ).toEqual([[ProfileCmsPackageStatus.PUBLISHED, 1]]);

    await resetTestDatabase();
    await rebuildProfileCms(
      {
        port: chain,
        fromHeight: 0,
        privateEntries: profileCmsPrivateEntries(
          (async function* () {
            for (const row of store.entries) {
              yield { entry: JSON.parse(row.entry) as RecordLogEntry };
            }
          })()
        )
      },
      ctx,
      { privateLog }
    );
    expect(await tableRows()).toEqual(live);
  });

  it("replays a write between two of one person's changes in one block after the first only", async () => {
    const store = new MemoryRecordLogStore();
    let clock = 900;
    const privateLog = new ProfileCmsPrivateLog(
      dbSupplier,
      new RecordLogWriter(store, { findGrantProofs: async () => [] }),
      { isProfileCmsPersonalLogEnabled: () => true },
      () => clock
    );
    const packagesDb = new ProfileCmsPackagesDb(dbSupplier, privateLog);
    const site = aSignedProfileSite({ draftId: 'draft-1', version: 1 });
    const chain = new InMemoryProfileCmsChain();
    chain.addSite(site);
    chain.setIdentity(aChainIdentity({ imported: false }));
    await packagesDb.insert(draftRow(site, 900), ctx);
    chain.replaceProfile({
      version: 1,
      height: 10,
      timeMs: 1_000,
      doc: aProfileDoc()
    });
    // Two PROFILE_REPLACEs of one person in block 20; the second names the draft.
    chain.replaceProfile({
      version: 2,
      height: 20,
      timeMs: 2_000,
      doc: aProfileDoc()
    });
    chain.replaceProfile({
      version: 3,
      height: 20,
      timeMs: 2_000,
      doc: aProfileDoc({
        primary: { publication: site.publicationCid, package: site.coreCid },
        archive: null
      })
    });
    // The publication isn't in the store yet: versions 1 and 2 apply, 3 waits.
    const hidden = chain.removeFile(site.publicationCid) as Buffer;
    await new ProfileCmsChainFollower(chain).syncFrom(0, ctx);
    // 6529.io writes the draft while version 3 waits.
    clock = 2_500;
    await packagesDb.recordPublication(
      'draft-1',
      site.publicationCid,
      { provider: 'arweave', uri: `ar://${'c'.repeat(43)}` },
      2_500,
      ctx
    );
    chain.addFile(hidden);
    await new ProfileCmsChainFollower(chain).syncFrom(0, ctx);
    const live = await tableRows();
    expect(
      (live.packages as { status: string }[]).map((row) => row.status)
    ).toEqual([ProfileCmsPackageStatus.PUBLISHED]);
    const stamped = store.entries.map(
      (row) =>
        (
          JSON.parse(row.entry) as {
            body: { height: number | null; doc_version: number | null };
          }
        ).body
    );
    expect(stamped.map((body) => [body.height, body.doc_version])).toEqual([
      [null, null],
      [20, 2]
    ]);

    await resetTestDatabase();
    await rebuildProfileCms(
      {
        port: chain,
        fromHeight: 0,
        privateEntries: profileCmsPrivateEntries(
          (async function* () {
            for (const row of store.entries) {
              yield { entry: JSON.parse(row.entry) as RecordLogEntry };
            }
          })()
        )
      },
      ctx,
      { privateLog }
    );
    expect(await tableRows()).toEqual(live);
  });

  it('fails instead of serving no site when a file stays missing', async () => {
    const site = aSignedProfileSite({ draftId: 'draft-1', version: 1 });
    const chain = new InMemoryProfileCmsChain();
    chain.setIdentity(aChainIdentity({ imported: false }));
    chain.replaceProfile({
      version: 1,
      height: 10,
      timeMs: 1_000,
      doc: aProfileDoc({
        primary: { publication: site.publicationCid, package: site.coreCid },
        archive: null
      })
    });
    await expect(
      rebuildProfileCms(
        { port: chain, fromHeight: 0, privateEntries: [] },
        ctx,
        { privateLog: { applyEntry: async () => undefined } }
      )
    ).rejects.toThrow('Profile site rebuild stopped');
    expect(await tableRows()).toMatchObject({ packages: [], events: [] });
  });
});
