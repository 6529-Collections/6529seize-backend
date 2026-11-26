import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DROPS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  SIGNED_RECORD_LOG_ENTRIES_TABLE,
  PROFILE_CMS_AGENT_EVENTS_TABLE,
  PROFILE_CMS_AGENT_GRANTS_TABLE,
  PROFILE_CMS_AGENT_PROPOSALS_TABLE,
  PROFILE_CMS_CHAIN_HEADS_TABLE,
  PROFILE_CMS_PACKAGES_TABLE,
  PROFILE_CMS_POINTER_EVENTS_TABLE,
  PROFILE_CMS_PUBLISH_SIGNATURES_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_METRICS_TABLE
} from '@/constants';
import { ProfileCmsPackageStatus } from '@/entities/IProfileCmsPackage';
import { rebuildProfileCmsFromChainAndLog } from '@/profile-cms/personal-log/profile-cms-rebuild';
import { seedProfileSites } from '@/rebuild/areas/publish.seed';
import { publishManifest } from '@/rebuild/manifests/publish.manifest';
import { RebuildContext } from '@/rebuild/manifest.types';
import { LocalRecordsWaveReader } from '@/signed-records/record-log/records-wave-local-reader';
import { loadProviderKeys } from '@/signed-records/sealed-crypto';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  aChainIdentity,
  aProfileDoc,
  aSignedProfileSite,
  InMemoryProfileCmsChain
} from '@/tests/fixtures/profile-cms-chain.fixture';

const FLAGS = publishManifest.flags;

const TABLES = {
  packages: [PROFILE_CMS_PACKAGES_TABLE, 'id'],
  events: [PROFILE_CMS_POINTER_EVENTS_TABLE, 'id'],
  signatures: [PROFILE_CMS_PUBLISH_SIGNATURES_TABLE, 'id'],
  grants: [PROFILE_CMS_AGENT_GRANTS_TABLE, 'id'],
  proposals: [PROFILE_CMS_AGENT_PROPOSALS_TABLE, 'id'],
  agentEvents: [PROFILE_CMS_AGENT_EVENTS_TABLE, 'id'],
  heads: [PROFILE_CMS_CHAIN_HEADS_TABLE, 'principal']
} as const;

async function rows(): Promise<Record<string, unknown[]>> {
  const read: Record<string, unknown[]> = {};
  for (const [name, [table, order]] of Object.entries(TABLES)) {
    read[name] = await sqlExecutor.execute(
      `select * from ${table} order by ${order}`
    );
  }
  return read;
}

async function emptyTheRebuiltTables(): Promise<void> {
  for (const [table] of Object.values(TABLES)) {
    await sqlExecutor.execute(`delete from ${table}`);
  }
}

function seedContext(dir: string): RebuildContext {
  return {
    area: 'publish',
    stepId: 'publish.seed',
    sources: {
      gateway: null,
      relays: null,
      ethereum: null,
      files: null,
      repo: null
    },
    seedFilesDir: dir,
    mark: { name: 'head', chainHeight: null, ethBlock: null },
    final: false
  };
}

/** The record log as the rebuild reads it, with segment files from `dir`. */
function recordLogFrom(dir: string) {
  return {
    wave: new LocalRecordsWaveReader({
      waveId: FLAGS.SIGNED_RECORDS_WAVE_ID,
      profileId: FLAGS.SIGNED_RECORDS_SERVICE_PROFILE_ID,
      wallet: FLAGS.SIGNED_RECORDS_SERVICE_WALLET
    }),
    fetcher: {
      fetchCid: async (cid: string) => fs.readFileSync(path.join(dir, cid)),
      fetchArweave: async (): Promise<Buffer> => {
        throw new Error('The seed archives nothing');
      }
    },
    serviceWallets: [FLAGS.SIGNED_RECORDS_SERVICE_WALLET],
    providers: loadProviderKeys(FLAGS.SIGNED_RECORDS_PROVIDER_KEYS)
  };
}

describeWithSeed('the publish area of the rebuild check', [], () => {
  const saved = { ...process.env };
  let dir: string;

  beforeEach(() => {
    Object.assign(process.env, FLAGS);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-seed-'));
  });

  afterEach(() => {
    for (const name of Object.keys(FLAGS)) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rebuilds every row the seed wrote from the private record log alone', async () => {
    await seedProfileSites(seedContext(dir), FLAGS);
    const seeded = await rows();
    expect(
      (
        seeded.packages as { id: string; status: string; is_primary: unknown }[]
      ).map((row) => [row.id, row.status, !!row.is_primary])
    ).toEqual([
      ['rebuild-publish-draft-1', ProfileCmsPackageStatus.PUBLISHED, true],
      ['rebuild-publish-draft-2', ProfileCmsPackageStatus.DRAFT, false]
    ]);
    expect(
      (seeded.events as { event_type: string }[]).map((row) => row.event_type)
    ).toEqual(['PUBLISH', 'SET_PRIMARY']);
    expect(seeded.signatures).toHaveLength(1);
    expect(seeded.grants).toHaveLength(1);
    expect(seeded.proposals).toHaveLength(1);
    expect(seeded.agentEvents).toHaveLength(1);

    await emptyTheRebuiltTables();
    const rebuilt = await rebuildProfileCmsFromChainAndLog(
      { sources: { gateway: null, files: null } },
      {
        features: { isProfileCmsChainPointerEnabled: () => false },
        recordLog: recordLogFrom(dir)
      }
    );
    expect(rebuilt.changes).toBe(0);
    expect(rebuilt.entries).toBeGreaterThan(0);
    expect(await rows()).toEqual(seeded);
  });

  it('takes the records service as it finds it, so either seed may run first', async () => {
    const service = {
      wallet: FLAGS.SIGNED_RECORDS_SERVICE_WALLET,
      profileId: FLAGS.SIGNED_RECORDS_SERVICE_PROFILE_ID
    };
    await sqlExecutor.execute(
      `insert into ${IDENTITIES_TABLE}
         (consolidation_key, profile_id, primary_address, handle,
          normalised_handle, tdh, rep, cic, level_raw, classification,
          xtdh, produced_xtdh, granted_xtdh, xtdh_rate, basetdh_rate)
       values (:wallet, :profileId, :wallet, 'rebuild-records',
          'rebuild-records', 0, 0, 0, 0, 'PSEUDONYM', 0, 0, 0, 0, 0)`,
      service
    );
    await seedProfileSites(seedContext(dir), FLAGS);
    expect(
      await sqlExecutor.execute(
        `select profile_id from ${IDENTITIES_TABLE} where profile_id = :profileId`,
        service
      )
    ).toHaveLength(1);
  });

  it("refuses to close another area's open record log entries", async () => {
    await sqlExecutor.execute(
      `insert into ${SIGNED_RECORD_LOG_ENTRIES_TABLE}
         (chain, lane, entry, created_at, segment_seq)
       values ('private', 'personal', '{}', 1, null)`
    );
    await expect(seedProfileSites(seedContext(dir), FLAGS)).rejects.toThrow(
      'open entries of other lanes (personal)'
    );
  });

  it('follows each head drop it posts, as drop creation does', async () => {
    await seedProfileSites(seedContext(dir), FLAGS);
    const follows = await sqlExecutor.execute<{
      subscriber_id: string;
      target_type: string;
      target_action: string;
    }>(
      `select subscriber_id, target_type, target_action from ${IDENTITY_SUBSCRIPTIONS_TABLE}
       where subscriber_id = :profileId`,
      { profileId: FLAGS.SIGNED_RECORDS_SERVICE_PROFILE_ID }
    );
    expect(follows.length).toBeGreaterThan(0);
    expect(
      follows.every(
        (row) =>
          row.target_type === 'DROP' && row.target_action === 'DROP_REPLIED'
      )
    ).toBe(true);
  });

  it("writes each head drop's wave and dropper metrics, as drop creation does", async () => {
    await seedProfileSites(seedContext(dir), FLAGS);
    // Plain SQL against the drops, not the metrics recount, so the check
    // doesn't compare the recount with itself.
    const waveId = FLAGS.SIGNED_RECORDS_WAVE_ID;
    const [want] = await sqlExecutor.execute<{
      drops: number;
      chat: number;
      participatory: number;
      latest: number;
    }>(
      `select count(*) as drops,
              sum(drop_type = 'CHAT') as chat,
              sum(drop_type = 'PARTICIPATORY') as participatory,
              max(created_at) as latest
         from ${DROPS_TABLE} where wave_id = :waveId`,
      { waveId }
    );
    expect(Number(want.drops)).toBeGreaterThan(0);
    const [row] = await sqlExecutor.execute<{
      drops_count: number;
      participatory_drops_count: number;
      latest_drop_timestamp: number;
    }>(
      `select drops_count, participatory_drops_count, latest_drop_timestamp
         from ${WAVE_METRICS_TABLE} where wave_id = :waveId`,
      { waveId }
    );
    expect(row).toBeDefined();
    expect(Number(row.drops_count)).toBe(Number(want.chat));
    expect(Number(row.participatory_drops_count)).toBe(
      Number(want.participatory)
    );
    expect(Number(row.latest_drop_timestamp)).toBe(Number(want.latest));
    // Each author's row, counts and time included.
    const authorsOff = await sqlExecutor.execute(
      `select d.wave_id, d.author_id
         from (select wave_id, author_id,
                      sum(drop_type = 'CHAT') as chat,
                      sum(drop_type = 'PARTICIPATORY') as participatory,
                      max(created_at) as latest
                 from ${DROPS_TABLE}
                where wave_id = :waveId
                group by wave_id, author_id) d
         left join ${WAVE_DROPPER_METRICS_TABLE} m
           on m.wave_id = d.wave_id and m.dropper_id = d.author_id
        where m.wave_id is null
           or m.drops_count <> d.chat
           or m.participatory_drops_count <> d.participatory
           or m.latest_drop_timestamp <> d.latest`,
      { waveId }
    );
    expect(authorsOff).toEqual([]);
    // The whole tables: the seed's one wave and author, nothing beside them.
    const waveRows = await sqlExecutor.execute<{ wave_id: string }>(
      `select wave_id from ${WAVE_METRICS_TABLE}`
    );
    expect(waveRows).toEqual([{ wave_id: waveId }]);
    const dropperRows = await sqlExecutor.execute<{
      wave_id: string;
      dropper_id: string;
    }>(`select wave_id, dropper_id from ${WAVE_DROPPER_METRICS_TABLE}`);
    expect(dropperRows).toEqual([
      { wave_id: waveId, dropper_id: FLAGS.SIGNED_RECORDS_SERVICE_PROFILE_ID }
    ]);
  });

  it('with the chain flag on, also applies the Profile changes from the chain port', async () => {
    const chain = new InMemoryProfileCmsChain();
    const site = aSignedProfileSite({ draftId: 'chain-draft-1' });
    chain.addSite(site);
    chain.setIdentity(aChainIdentity({ imported: false }));
    chain.replaceProfile({
      version: 1,
      height: 100,
      timeMs: 1_000,
      doc: aProfileDoc({
        primary: { publication: site.publicationCid, package: site.coreCid },
        archive: null
      })
    });
    const createPort = jest.fn().mockReturnValue(chain);
    const rebuilt = await rebuildProfileCmsFromChainAndLog(
      { sources: { gateway: 'https://gateway.example.test', files: null } },
      {
        features: { isProfileCmsChainPointerEnabled: () => true },
        createPort,
        recordLog: recordLogFrom(dir)
      }
    );
    expect(createPort).toHaveBeenCalledWith('https://gateway.example.test');
    expect(rebuilt).toEqual({ changes: 1, entries: 0 });
    const after = await rows();
    expect(
      (after.packages as { status: string; is_primary: unknown }[]).map(
        (row) => [row.status, !!row.is_primary]
      )
    ).toEqual([[ProfileCmsPackageStatus.PUBLISHED, true]]);
    expect(after.heads).toHaveLength(1);
  });
});
