import 'reflect-metadata';
import {
  CMS_SITES_TABLE,
  PROFILE_CMS_CHAIN_HEADS_TABLE,
  PROFILE_CMS_CHAIN_PARKED_TABLE,
  PROFILE_CMS_PACKAGES_TABLE
} from '@/constants';
import { Logger } from '@/logging';
import {
  encodeProfileCmsArchive,
  PROFILE_CMS_ARCHIVE_SCHEMA
} from '@/profile-cms/chain/profile-cms-archive';
import {
  followProfileCmsChanges,
  PROFILE_CMS_MAX_CHANGE_ATTEMPTS,
  PROFILE_CMS_PARKED_ALERT_MS,
  ProfileCmsChainFollower
} from '@/profile-cms/chain/profile-cms-chain-follower';
import { profileCmsChainDb } from '@/profile-cms/chain/profile-cms-chain.db';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  aChainIdentity,
  aProfileDoc,
  aSignedProfileSite,
  CHAIN_FIXTURE_HANDLE,
  CHAIN_FIXTURE_PRINCIPAL,
  CHAIN_FIXTURE_PROFILE_ID,
  InMemoryProfileCmsChain
} from '@/tests/fixtures/profile-cms-chain.fixture';

const ctx: RequestContext = { timer: undefined };
const OTHER = `0x${'0'.repeat(63)}2`;
const T = Date.parse('2026-11-25T02:00:00.000Z');

async function heads(): Promise<Record<string, unknown>[]> {
  return sqlExecutor.execute(
    `select principal, doc_version, height from ${PROFILE_CMS_CHAIN_HEADS_TABLE} order by principal`
  );
}

async function parked(): Promise<Record<string, unknown>[]> {
  return sqlExecutor.execute(
    `select principal, version, height, attempts, reason, parked_at, alerted_at from ${PROFILE_CMS_CHAIN_PARKED_TABLE} order by principal, version`
  );
}

async function primaryOf(profileId: string): Promise<string | null> {
  const rows = await sqlExecutor.execute<{ id: string }>(
    `select id from ${PROFILE_CMS_PACKAGES_TABLE} where profile_id = :profileId and is_primary = true and status = 'PUBLISHED'`,
    { profileId }
  );
  return rows[0]?.id ?? null;
}

function setup() {
  const chain = new InMemoryProfileCmsChain();
  chain.setIdentity(aChainIdentity());
  chain.setIdentity(
    aChainIdentity({ principal: OTHER, profile_id: 'test-profile-2' })
  );
  const site = aSignedProfileSite({ draftId: 'draft-1' });
  chain.addSite(site);
  const pointer = aProfileDoc({
    primary: { publication: site.publicationCid, package: site.coreCid },
    archive: null
  });
  return { chain, site, pointer };
}

describeWithSeed('profile site changes that must wait', [], () => {
  it("parks a missing document with that person's later changes behind it, and reads on", async () => {
    const { chain, site, pointer } = setup();
    const missingDoc = chain.replaceProfile({
      version: 1,
      height: 100,
      timeMs: T,
      doc: aProfileDoc({})
    }) as string;
    const hidden = chain.removeFile(missingDoc) as Buffer;
    chain.replaceProfile({
      version: 2,
      height: 110,
      timeMs: T + 10,
      doc: pointer
    });
    chain.replaceProfile({
      principal: OTHER,
      version: 1,
      height: 105,
      timeMs: T + 5,
      doc: aProfileDoc(null)
    });

    const follower = new ProfileCmsChainFollower(
      chain,
      undefined,
      undefined,
      'live',
      () => T
    );
    expect(await follower.syncFrom(0, ctx)).toEqual({
      applied: 1,
      nextHeight: 111,
      waiting: 1
    });
    expect(await heads()).toEqual([
      { principal: OTHER, doc_version: 1, height: 105 }
    ]);
    expect(await parked()).toEqual([
      {
        principal: CHAIN_FIXTURE_PRINCIPAL,
        version: 1,
        height: 100,
        attempts: 1,
        reason: 'profile_doc_not_found',
        parked_at: T,
        alerted_at: null
      },
      {
        principal: CHAIN_FIXTURE_PRINCIPAL,
        version: 2,
        height: 110,
        attempts: 0,
        reason: null,
        parked_at: T,
        alerted_at: null
      }
    ]);
    // The cursor is past the parked changes: the feed isn't read again from 100.
    expect(await profileCmsChainDb.cursorHeight(0, ctx)).toBe(110);
    expect(await primaryOf('test-profile-1')).toBeNull();

    // The document arrives: both parked changes apply, in order.
    chain.addFile(hidden);
    expect(await follower.syncFrom(111, ctx)).toEqual({
      applied: 2,
      nextHeight: 111,
      waiting: 0
    });
    expect(await parked()).toEqual([]);
    expect(await primaryOf('test-profile-1')).toBe(site.draftId);
  });

  it('applies a change as it reads after the last try: a missing site file serves nothing', async () => {
    const { chain, site, pointer } = setup();
    chain.replaceProfile({ version: 1, height: 100, timeMs: T, doc: pointer });
    chain.removeFile(site.publicationCid);
    const follower = new ProfileCmsChainFollower(chain);
    for (
      let attempt = 1;
      attempt < PROFILE_CMS_MAX_CHANGE_ATTEMPTS;
      attempt++
    ) {
      expect(
        await follower.applyChange((await chain.getChanges(0)).changes[0], ctx)
      ).toEqual({
        status: 'retry',
        reason: 'publication_not_found',
        attempt
      });
    }
    expect(
      await follower.applyChange((await chain.getChanges(0)).changes[0], ctx)
    ).toEqual({
      status: 'applied',
      events: 0,
      refused: 'publication_not_found'
    });
    expect(await heads()).toEqual([
      { principal: CHAIN_FIXTURE_PRINCIPAL, doc_version: 1, height: 100 }
    ]);
    expect(await parked()).toEqual([]);
  });

  it('catches up from its own cursor when the flag comes back on', async () => {
    const { chain, site, pointer } = setup();
    let enabled = true;
    const features = { isProfileCmsChainPointerEnabled: () => enabled };
    chain.replaceProfile({
      version: 1,
      height: 100,
      timeMs: T,
      doc: aProfileDoc(null)
    });
    expect(await followProfileCmsChanges(chain, ctx, { features })).toEqual({
      applied: 1,
      nextHeight: 101,
      waiting: 0
    });

    enabled = false;
    chain.replaceProfile({
      version: 2,
      height: 110,
      timeMs: T + 10,
      doc: pointer
    });
    expect(await followProfileCmsChanges(chain, ctx, { features })).toBeNull();
    expect(await primaryOf('test-profile-1')).toBeNull();

    enabled = true;
    expect(await followProfileCmsChanges(chain, ctx, { features })).toEqual({
      applied: 1,
      nextHeight: 111,
      waiting: 0
    });
    expect(await primaryOf('test-profile-1')).toBe(site.draftId);
  });
});

/** A history file with one legacy site, as the export writes it. */
function legacyOnlyArchive(): Buffer {
  return encodeProfileCmsArchive({
    schema: PROFILE_CMS_ARCHIVE_SCHEMA,
    profile_id: CHAIN_FIXTURE_PROFILE_ID,
    profile_handle: CHAIN_FIXTURE_HANDLE,
    frozen_at: 1,
    packages: [],
    pointer_events: [],
    publish_signatures: [],
    legacy: {
      sites: [
        {
          id: 'legacy-site-1',
          owner_profile_id: CHAIN_FIXTURE_PROFILE_ID,
          slug: 's',
          title: 'Legacy',
          description: null,
          primary_package_hash: null,
          primary_static_path: null,
          created_at: 1,
          updated_at: 1,
          created_by_wallet: `0x${'0'.repeat(39)}1`,
          updated_by_wallet: null
        }
      ],
      packages: []
    }
  });
}

async function legacySites(): Promise<unknown[]> {
  return sqlExecutor.execute(`select id from ${CMS_SITES_TABLE}`);
}

describeWithSeed("the identity import's own documents", [], () => {
  it('waits on an import still running, without using up tries, alerts once, then imports its history', async () => {
    const chain = new InMemoryProfileCmsChain();
    const archive = chain.addFile(legacyOnlyArchive());
    chain.setIdentity(aChainIdentity());
    chain.setIdentityImport({ start_height: 100, done_height: null });
    chain.replaceProfile({
      version: 1,
      height: 100,
      timeMs: T,
      doc: aProfileDoc({ archive })
    });
    let now = T;
    const follower = () =>
      new ProfileCmsChainFollower(
        chain,
        undefined,
        undefined,
        'live',
        () => now
      );
    const alert = jest
      .spyOn(Logger.prototype, 'errorWithCode')
      .mockImplementation(() => undefined);
    for (let run = 1; run <= PROFILE_CMS_MAX_CHANGE_ATTEMPTS + 1; run++) {
      expect(await follower().syncFrom(0, ctx)).toEqual({
        applied: 0,
        nextHeight: 101,
        waiting: 1
      });
      now += PROFILE_CMS_PARKED_ALERT_MS / 2;
    }
    expect(await heads()).toEqual([]);
    expect(await parked()).toEqual([
      {
        principal: CHAIN_FIXTURE_PRINCIPAL,
        version: 1,
        height: 100,
        attempts: 0,
        reason: 'identity_import_running',
        parked_at: T,
        alerted_at: T + PROFILE_CMS_PARKED_ALERT_MS
      }
    ]);
    expect(alert.mock.calls).toEqual([
      [
        'PROFILE_SITE_CHANGE_STALLED',
        `Profile site change for ${CHAIN_FIXTURE_PRINCIPAL} at 100 has waited 30 minutes: identity_import_running`
      ]
    ]);
    alert.mockRestore();
    expect(await legacySites()).toEqual([]);

    // The import completes; the next run decides and imports the history.
    chain.setIdentityImport({ start_height: 100, done_height: 180 });
    expect(await follower().syncFrom(101, ctx)).toEqual({
      applied: 1,
      nextHeight: 101,
      waiting: 0
    });
    expect(await parked()).toEqual([]);
    expect(await legacySites()).toEqual([{ id: 'legacy-site-1' }]);
  });

  it("in the import's last block, ignores a person's own version 1", async () => {
    const chain = new InMemoryProfileCmsChain();
    const archive = chain.addFile(legacyOnlyArchive());
    chain.setIdentity(aChainIdentity());
    chain.setIdentityImport({ start_height: 100, done_height: 180 });
    // The import wrote no document for this person; in block 180, after the
    // import's last units, they write their own version 1 naming an archive.
    chain.replaceProfile({
      version: 1,
      height: 180,
      timeMs: T,
      doc: aProfileDoc({ archive })
    });
    await new ProfileCmsChainFollower(chain).syncFrom(0, ctx);
    expect(await legacySites()).toEqual([]);
  });

  it("in the import's last block, imports the document its list names", async () => {
    const chain = new InMemoryProfileCmsChain();
    const archive = chain.addFile(legacyOnlyArchive());
    chain.setIdentity(aChainIdentity());
    chain.setIdentityImport({ start_height: 100, done_height: 180 });
    chain.replaceProfile({
      version: 1,
      height: 180,
      timeMs: T,
      doc: aProfileDoc({ archive }),
      importDoc: true
    });
    await new ProfileCmsChainFollower(chain).syncFrom(0, ctx);
    expect(await legacySites()).toEqual([{ id: 'legacy-site-1' }]);
  });
});
