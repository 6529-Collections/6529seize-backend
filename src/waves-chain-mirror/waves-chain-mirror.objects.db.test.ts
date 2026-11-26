import 'reflect-metadata';
import {
  ACTIVITY_EVENTS_TABLE,
  ADDRESS_CONSOLIDATION_KEY,
  CHAIN_ENTRY_HOLDS_TABLE,
  CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  PROFILE_GROUP_CHANGES,
  PROFILE_GROUPS_TABLE,
  USER_GROUPS_TABLE,
  WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE,
  WAVES_CHAIN_MIRROR_GROUPS_TABLE,
  WAVES_CHAIN_MIRROR_STATE_TABLE,
  WAVES_CHAIN_MIRROR_WAVES_TABLE,
  WAVES_METADATA_TABLE,
  WAVES_TABLE
} from '@/constants';
import { rawCidHexOf } from '@/chain-gateway/chain-gateway.client';
import { WavesApiDb } from '@/api/waves/waves.api.db';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { sqlExecutor } from '@/sql-executor';
import {
  clearMirrorTables,
  dumpTables,
  ensurePrincipalMap,
  mapPrincipals
} from '@/tests/fixtures/waves-chain-mirror.db.fixture';
import {
  aChainGroupRow,
  aChainWaveRow,
  aWaveDoc,
  chainWord
} from '@/tests/fixtures/waves-chain-mirror.objects.fixture';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { WavesChainIndexDb } from '@/waves-chain-index/waves-chain-index.db';
import {
  ChainEvent,
  UNKNOWN_SCAN
} from '@/waves-chain-index/waves-chain-index.events';
import { groupRow, waveRow } from '@/waves-chain-index/waves-chain-index.rows';
import { ChainObject } from '@/waves-chain-index/waves-chain-index.api';
import { WavesChainMirrorDb } from './waves-chain-mirror.db';
import { StoredDocuments } from './waves-chain-mirror.docs';
import {
  GateVerdict,
  ModerationContentGate,
  moderationSubjectId
} from './waves-chain-mirror.gate';
import {
  groupListId,
  groupShortIdOf,
  waveDescriptionDropId
} from './waves-chain-mirror.ids';
import { WavesChainObjectsMirror } from './waves-chain-mirror.objects';
import { WavesChainObjectsDb } from './waves-chain-mirror.objects.db';
import { defaultObjectEffects } from './waves-chain-mirror.objects.effects';
import { groupRowOf, NO_CRITERIA } from './waves-chain-mirror.groups';
import { PlanCounter } from './waves-chain-mirror.plan-support';

const NOW = 1_765_000_000_000;
const CREATED_AT = 1_764_500_000_000;
const G = chainWord('0a');
const W = chainWord('0b');
const W_IMPORTED = chainWord('0c');
const P1 = chainWord('11');
const P2 = chainWord('22');
const A1 = `0x${'a1'.repeat(20)}`;
const A2 = `0x${'a2'.repeat(20)}`;
const LEGACY_GROUP = '6f1c2a5e-3b4d-4e8f-9a0b-1c2d3e4f5a6b';
const LEGACY_WAVE = '0b1c2d3e-0000-4000-8000-0000000000aa';
const IMPORTED_GROUP_ID = `readers-${groupShortIdOf(LEGACY_GROUP)}`;

const TABLES = [
  WAVES_TABLE,
  USER_GROUPS_TABLE,
  PROFILE_GROUPS_TABLE,
  DROPS_TABLE,
  DROPS_PARTS_TABLE,
  WAVES_METADATA_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE,
  ACTIVITY_EVENTS_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  IDENTITIES_TABLE,
  WAVES_CHAIN_MIRROR_GROUPS_TABLE,
  WAVES_CHAIN_MIRROR_WAVES_TABLE
];

const waveCreated = (waveId: string): ChainEvent => ({
  height: 20,
  seq: 0,
  blockTime: CREATED_AT,
  kind: 'WAVE_CREATED',
  origin: 'OPERATION',
  waveId,
  waveLegacyId: null,
  decisionId: null,
  decisionLegacyId: null,
  entryId: null,
  entryLegacyId: null,
  pollId: null,
  pollLegacyId: null,
  groupId: null,
  groupLegacyId: null,
  actor: P1,
  data: {}
});

describe('WavesChainObjectsMirror in the database', () => {
  beforeEach(() => clearMirrorTables(sqlExecutor));

  const db = new WavesChainMirrorDb(() => sqlExecutor);
  const index = new WavesChainIndexDb(() => sqlExecutor);
  const objectsDb = new WavesChainObjectsDb(() => sqlExecutor);
  const waves = new WavesApiDb(() => sqlExecutor);
  const groups = new UserGroupsDb(() => sqlExecutor);
  const stamp = { height: 20, generation: 1 };

  const run = async (verdict: GateVerdict = { kind: 'allowed' }) => {
    const counter = new PlanCounter();
    const report = await new WavesChainObjectsMirror(
      objectsDb,
      (ids) => db.profilesOfPrincipals(ids),
      defaultObjectEffects,
      { check: jest.fn().mockResolvedValue(verdict) },
      () => NOW
    ).run({
      write: true,
      documents: new StoredDocuments(
        db,
        { getDocument: jest.fn().mockResolvedValue(null) },
        true
      ),
      counter,
      outOfTime: () => false
    });
    return { report, counter };
  };

  const seedGroup = (row: ReturnType<typeof aChainGroupRow>) =>
    index.upsert(
      'groups',
      [groupRow({ ...(row.data as ChainObject), legacyId: row.legacy_id })],
      stamp
    );
  const seedWave = (row: ReturnType<typeof aChainWaveRow>) =>
    index.upsert(
      'waves',
      [
        waveRow({
          ...(row.data as ChainObject),
          legacyId: row.legacy_id,
          origin: row.origin,
          status: row.status,
          readGroup: { groupId: row.read_group_id ?? chainWord('00') },
          postGroup: { groupId: row.post_group_id ?? chainWord('00') },
          adminGroup: { groupId: row.admin_group_id ?? chainWord('00') }
        })
      ],
      stamp
    );
  const seedDocument = async (doc: unknown) => {
    const bytes = Buffer.from(`${JSON.stringify(doc)}\n`);
    const cid = rawCidHexOf(bytes);
    await db.saveDocument(cid, 3, bytes);
    return cid;
  };

  it("writes a group and a wave made on the chain as 6529.io's create does, and nothing the second time", async () => {
    await ensurePrincipalMap(sqlExecutor);
    await mapPrincipals(sqlExecutor, { [P1]: 'profile-1', [P2]: 'profile-2' });
    // A1 has an identity on 6529.io; A2 has none.
    await sqlExecutor.execute(
      `insert into ${IDENTITIES_TABLE}
         (profile_id, consolidation_key, primary_address, tdh, rep, cic, level_raw)
       values ('profile-a1', :a, :a, 0, 0, 0, 0)`,
      { a: A1 }
    );
    await sqlExecutor.execute(
      `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
       values (:a, :a)`,
      { a: A1 }
    );
    await seedGroup(
      aChainGroupRow(G, {
        includes: [
          { kind: 'principal', value: P1 },
          { kind: 'address', value: A1 },
          { kind: 'address', value: A2 }
        ],
        excludes: [{ kind: 'principal', value: P2 }]
      })
    );
    const cid = await seedDocument(aWaveDoc());
    await seedWave(aChainWaveRow(W, { read: G, admin: G, metadataCid: cid }));
    await index.writeEvents([waveCreated(W)], 21, UNKNOWN_SCAN);

    const { report } = await run();
    expect(report.groups).toMatchObject({ mirrored: 1, failed: 0 });
    expect(report.waves).toMatchObject({ mirrored: 1, failed: 0 });

    // The group, its lists, and the identity 6529.io gives a listed address.
    const group = await groups.getByIdWithoutVisibilityCheck(G);
    expect(group).toMatchObject({
      id: G,
      name: `Group ${G.slice(0, 10)}`,
      created_by: 'profile-1',
      profile_group_id: groupListId(G, 1, 'include'),
      excluded_profile_group_id: groupListId(G, 1, 'exclude')
    });
    const lists = await sqlExecutor.execute<{
      profile_group_id: string;
      profile_id: string;
    }>(`select profile_group_id, profile_id from ${PROFILE_GROUPS_TABLE}`);
    const a2 = await sqlExecutor.execute<{ profile_id: string }>(
      `select i.profile_id from ${IDENTITIES_TABLE} i
         join ${ADDRESS_CONSOLIDATION_KEY} a on a.consolidation_key = i.consolidation_key
        where a.address = :a`,
      { a: A2 }
    );
    expect(a2).toHaveLength(1);
    expect(
      lists
        .filter((r) => r.profile_group_id === groupListId(G, 1, 'include'))
        .map((r) => r.profile_id)
        .sort()
    ).toEqual(['profile-1', 'profile-a1', a2[0].profile_id].sort());
    expect(
      lists
        .filter((r) => r.profile_group_id === groupListId(G, 1, 'exclude'))
        .map((r) => r.profile_id)
    ).toEqual(['profile-2']);
    const changes = await sqlExecutor.execute<{ profile_id: string }>(
      `select distinct profile_id from ${PROFILE_GROUP_CHANGES}`
    );
    expect(changes.map((c) => c.profile_id)).toEqual(
      expect.arrayContaining(['profile-1', 'profile-2', 'profile-a1'])
    );

    // The wave, read as 6529.io's routes read it.
    const wave = await waves.findWaveById(W);
    expect(wave).toMatchObject({
      id: W,
      name: 'Made on the chain',
      created_by: 'profile-1',
      created_at: CREATED_AT,
      visibility_group_id: G,
      admin_group_id: G,
      chat_group_id: null,
      chat_enabled: true,
      chat_replies_open: true,
      admin_drop_deletion_enabled: true,
      description_drop_id: waveDescriptionDropId(W),
      parent_wave_id: null,
      is_direct_message: false
    });
    expect(
      await sqlExecutor.execute(
        `select d.author_id, d.drop_type, d.wave_id, d.created_at, p.content
           from ${DROPS_TABLE} d join ${DROPS_PARTS_TABLE} p on p.drop_id = d.id
          where d.id = :id`,
        { id: waveDescriptionDropId(W) }
      )
    ).toEqual([
      {
        author_id: 'profile-1',
        drop_type: 'CHAT',
        wave_id: W,
        created_at: CREATED_AT,
        content: 'What this wave is about'
      }
    ]);
    expect(
      await sqlExecutor.execute(
        `select data_key, data_value from ${WAVES_METADATA_TABLE}`
      )
    ).toEqual([
      { data_key: 'wave_display.rules.custom', data_value: 'Be kind' }
    ]);
    // identity_subscriptions.target_id (varchar(50)) can't hold a chain
    // id: the creator's follow waits for the column to be widened.
    expect(
      await sqlExecutor.execute(`select 1 from ${IDENTITY_SUBSCRIPTIONS_TABLE}`)
    ).toEqual([]);
    expect(
      await sqlExecutor.execute(
        `select identity_id, wave_id from ${WAVE_GROUP_NOTIFICATION_SUBSCRIPTIONS_TABLE}`
      )
    ).toEqual([{ identity_id: 'profile-1', wave_id: W }]);
    expect(
      await sqlExecutor.execute(
        `select target_id, action, wave_id, visibility_group_id
           from ${ACTIVITY_EVENTS_TABLE}`
      )
    ).toEqual([
      {
        target_id: 'profile-1',
        action: 'WAVE_CREATED',
        wave_id: W,
        visibility_group_id: G
      }
    ]);

    const first = await dumpTables(sqlExecutor, TABLES);
    const again = await run();
    expect(again.report.groups).toMatchObject({ mirrored: 0, unchanged: 1 });
    expect(again.report.waves).toMatchObject({ mirrored: 0, unchanged: 1 });
    expect(await dumpTables(sqlExecutor, TABLES)).toEqual(first);
  });

  it("applies the chain's replaced group and policy to an imported group and wave, visibility included", async () => {
    await ensurePrincipalMap(sqlExecutor);
    await mapPrincipals(sqlExecutor, { [P1]: 'profile-1', [P2]: 'profile-2' });
    // 6529.io's group and wave as imported, with a notification and a feed
    // item of the wave.
    await groups.save(
      groupRowOf({
        id: IMPORTED_GROUP_ID,
        name: 'Readers',
        createdAt: new Date(1_700_000_000_000),
        createdBy: 'profile-1',
        criteria: NO_CRITERIA,
        repUser: null,
        includeListId: 'old-list',
        excludeListId: null,
        visible: true,
        isPrivate: false
      }),
      undefined as never
    );
    await sqlExecutor.execute(
      `insert into ${PROFILE_GROUPS_TABLE} (profile_group_id, profile_id)
       values ('old-list', 'profile-old')`
    );
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) =>
      waves.insertWave(
        {
          ...aWave(
            { created_by: 'profile-1', visibility_group_id: null },
            { id: LEGACY_WAVE, serial_no: 1, name: 'Imported' }
          ),
          participation_required_metadata: [],
          participation_required_media: [],
          is_direct_message: false,
          voting_credit_nfts: []
        },
        { connection }
      )
    );
    await sqlExecutor.execute(
      `insert into ${IDENTITY_NOTIFICATIONS_TABLE}
         (identity_id, cause, additional_data, created_at, wave_id,
          visibility_group_id)
       values ('profile-1', 'IDENTITY_MENTIONED', '{}', 1, :wave, null)`,
      { wave: LEGACY_WAVE }
    );
    await sqlExecutor.execute(
      `insert into ${ACTIVITY_EVENTS_TABLE}
         (target_id, target_type, action, drop_id, data, visibility_group_id,
          created_at, wave_id, action_author_id)
       values ('profile-1', 'IDENTITY', 'WAVE_CREATED', null, '{}', null, 1,
          :wave, 'profile-1')`,
      { wave: LEGACY_WAVE }
    );
    // The chain replaced the group (a list of P2) and the wave's policy
    // (that group reads it).
    await seedGroup(
      aChainGroupRow(
        G,
        { includes: [{ kind: 'principal', value: P2 }] },
        { version: 2, origin: 'legacy', legacyId: LEGACY_GROUP }
      )
    );
    await seedWave(
      aChainWaveRow(W_IMPORTED, {
        origin: 'legacy',
        legacyId: LEGACY_WAVE,
        policyVersion: 2,
        read: G
      })
    );

    const { report } = await run();
    expect(report.groups).toMatchObject({ mirrored: 1, failed: 0 });
    expect(report.waves).toMatchObject({ mirrored: 1, failed: 0 });
    expect(
      await groups.getByIdWithoutVisibilityCheck(IMPORTED_GROUP_ID)
    ).toMatchObject({
      name: 'Readers',
      profile_group_id: groupListId(G, 2, 'include')
    });
    expect(
      await sqlExecutor.execute(
        `select profile_group_id, profile_id from ${PROFILE_GROUPS_TABLE}`
      )
    ).toEqual([
      {
        profile_group_id: groupListId(G, 2, 'include'),
        profile_id: 'profile-2'
      }
    ]);
    expect(await waves.findWaveById(LEGACY_WAVE)).toMatchObject({
      name: 'Imported',
      visibility_group_id: IMPORTED_GROUP_ID,
      created_by: 'profile-1'
    });
    expect(
      await sqlExecutor.execute(
        `select visibility_group_id from ${IDENTITY_NOTIFICATIONS_TABLE}`
      )
    ).toEqual([{ visibility_group_id: IMPORTED_GROUP_ID }]);
    expect(
      await sqlExecutor.execute(
        `select visibility_group_id from ${ACTIVITY_EVENTS_TABLE}`
      )
    ).toEqual([{ visibility_group_id: IMPORTED_GROUP_ID }]);

    const first = await dumpTables(sqlExecutor, TABLES);
    const again = await run();
    expect(again.report.waves).toMatchObject({ mirrored: 0, unchanged: 1 });
    expect(await dumpTables(sqlExecutor, TABLES)).toEqual(first);
  });

  it("keeps a wave description's moderation hold in chain_entry_holds, and reads it from there", async () => {
    await ensurePrincipalMap(sqlExecutor);
    await mapPrincipals(sqlExecutor, { [P1]: 'profile-1' });
    await seedGroup(
      aChainGroupRow(G, { includes: [{ kind: 'principal', value: P1 }] })
    );
    const cid = await seedDocument(aWaveDoc());
    await seedWave(aChainWaveRow(W, { read: G, admin: G, metadataCid: cid }));
    await index.writeEvents([waveCreated(W)], 21, UNKNOWN_SCAN);
    const dropId = waveDescriptionDropId(W);
    const holdRows = () =>
      sqlExecutor.execute<Record<string, unknown>>(
        `select entry_id, competition_id, reason, retry_at, attempts, held_at
           from ${CHAIN_ENTRY_HOLDS_TABLE}`
      );
    const content = async () =>
      (
        await sqlExecutor.execute<{ content: string | null }>(
          `select content from ${DROPS_PARTS_TABLE} where drop_id = :dropId`,
          { dropId }
        )
      ).map((row) => row.content);

    // Refused: the wave is written with an empty description, the hold kept
    // under the description drop id.
    await run({ kind: 'refused', code: 'REJECTED' });
    expect(await content()).toEqual([null]);
    expect(await holdRows()).toEqual([
      {
        entry_id: dropId,
        competition_id: '',
        reason: 'description_moderation',
        retry_at: null,
        attempts: 1,
        held_at: NOW
      }
    ]);
    expect(await objectsDb.descriptionHold(dropId)).toEqual({
      reason: 'description_moderation',
      retryAt: null,
      attempts: 1
    });
    expect(
      await sqlExecutor.execute(
        `select held, retry_at from ${WAVES_CHAIN_MIRROR_WAVES_TABLE}`
      )
    ).toEqual([{ held: 'description_moderation', retry_at: null }]);

    // A rebuild's store keeps the live mirror's holds as they are.
    const rebuildDb = new WavesChainObjectsDb(() => sqlExecutor, 'rebuild');
    await rebuildDb.holdDescription(
      dropId,
      { reason: 'description_moderation_deferred', retryAt: 1, attempts: 9 },
      NOW
    );
    await rebuildDb.releaseDescription(dropId);
    expect(await rebuildDb.carryDescriptionHolds(NOW)).toBe(0);
    expect(await holdRows()).toHaveLength(1);
    expect(await objectsDb.descriptionHold(dropId)).toMatchObject({
      reason: 'description_moderation'
    });

    // A new description, allowed: written, and the hold released.
    const next = await seedDocument(
      aWaveDoc({ description: [{ content: 'Rewritten', media: [] }] })
    );
    await seedWave(aChainWaveRow(W, { read: G, admin: G, metadataCid: next }));
    await run();
    expect(await content()).toEqual(['Rewritten']);
    expect(await holdRows()).toEqual([]);
  });

  it('carries the description holds the wave records kept over into chain_entry_holds, once', async () => {
    await ensurePrincipalMap(sqlExecutor);
    await mapPrincipals(sqlExecutor, { [P1]: 'profile-1' });
    await seedGroup(
      aChainGroupRow(G, { includes: [{ kind: 'principal', value: P1 }] })
    );
    const cid = await seedDocument(aWaveDoc());
    await seedWave(aChainWaveRow(W, { read: G, admin: G, metadataCid: cid }));
    await index.writeEvents([waveCreated(W)], 21, UNKNOWN_SCAN);
    await run();
    // As an earlier mirror left it: the hold in the wave's record only.
    await sqlExecutor.execute(`delete from ${WAVES_CHAIN_MIRROR_STATE_TABLE}`);
    await sqlExecutor.execute(
      `update ${WAVES_CHAIN_MIRROR_WAVES_TABLE}
          set held = 'description_moderation_deferred', retry_at = :retryAt,
              attempts = 2, updated_at = :updatedAt`,
      { retryAt: NOW + 60_000, updatedAt: NOW - 1_000 }
    );
    expect(await objectsDb.carryDescriptionHolds(NOW)).toBe(1);
    const kept = {
      entry_id: waveDescriptionDropId(W),
      competition_id: '',
      reason: 'description_moderation_deferred',
      retry_at: NOW + 60_000,
      attempts: 2,
      held_at: NOW - 1_000
    };
    expect(
      await sqlExecutor.execute(
        `select entry_id, competition_id, reason, retry_at, attempts, held_at
           from ${CHAIN_ENTRY_HOLDS_TABLE}`
      )
    ).toEqual([kept]);
    // Once: a hold released afterwards is not carried over again.
    await sqlExecutor.execute(`delete from ${CHAIN_ENTRY_HOLDS_TABLE}`);
    expect(await objectsDb.carryDescriptionHolds(NOW)).toBe(0);
    await run();
    expect(
      await sqlExecutor.execute(`select 1 from ${CHAIN_ENTRY_HOLDS_TABLE}`)
    ).toEqual([]);
  });
});

describe('ModerationContentGate in the database', () => {
  beforeEach(() => clearMirrorTables(sqlExecutor));

  it("judges a drop with a chain id, recording its check under an id moderation's tables hold", async () => {
    const dropId = chainWord('e9');
    const verdict = await new ModerationContentGate().check({
      dropId,
      authorProfileId: 'profile-1',
      waveId: W,
      content: {
        title: null,
        parts: [
          {
            content: 'A plain description',
            quotedDropId: null,
            quotedDropPartId: null,
            media: []
          }
        ],
        metadata: [],
        referencedNfts: [],
        mentionedUsers: [],
        mentionedWaves: [],
        mentionedGroups: [],
        hideLinkPreview: false,
        isAdditionalActionPromised: null,
        collaboratorIds: [],
        attachmentsLeftOut: 0
      }
    });
    expect(verdict).toEqual({ kind: 'allowed' });
    expect(
      await sqlExecutor.execute(
        `select drop_id, outcome from ${CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE}`
      )
    ).toEqual([{ drop_id: moderationSubjectId(dropId), outcome: 'ALLOW' }]);
  });
});
