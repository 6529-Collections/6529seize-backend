import 'reflect-metadata';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import {
  ACTIVITY_EVENTS_TABLE,
  ADDRESS_CONSOLIDATION_KEY,
  CHAIN_ENTRY_HOLDS_TABLE,
  CONSOLIDATIONS_TABLE,
  CONTENT_MODERATION_PRE_PUBLICATION_CHECKS_TABLE,
  DROPS_PARTS_TABLE,
  DROPS_TABLE,
  IDENTITIES_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  PROFILE_GROUP_CHANGES,
  PROFILE_GROUPS_TABLE,
  PROFILES_TABLE,
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
  identityMirrorAt,
  mapPrincipals
} from '@/tests/fixtures/waves-chain-mirror.db.fixture';
import { addressIdentityId } from '@/identities/address-identity-id';
import { IdentityChainMirrorDb } from '@/identity-chain-mirror/identity-chain-mirror.db';
import { planIdentity } from '@/identity-chain-mirror/identity-plan';
import { EMPTY_PROFILE_DOC_FIELDS } from '@/identity-chain-mirror/profile-doc';
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

  const run = async (
    verdict: GateVerdict = { kind: 'allowed' },
    store: WavesChainObjectsDb = objectsDb,
    write = true,
    outOfTime: () => boolean = () => false
  ) => {
    const counter = new PlanCounter();
    const report = await new WavesChainObjectsMirror(
      store,
      (ids) => db.profilesOfPrincipals(ids),
      defaultObjectEffects,
      { check: jest.fn().mockResolvedValue(verdict) },
      () => NOW
    ).run({
      write,
      documents: new StoredDocuments(
        db,
        { getDocument: jest.fn().mockResolvedValue(null) },
        true
      ),
      counter,
      outOfTime
    });
    return { report, counter };
  };
  const changeLog = () =>
    sqlExecutor.execute<{ profile_id: string }>(
      `select profile_id from ${PROFILE_GROUP_CHANGES} order by id`
    );

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
    // The identity mirror stands at the group's height (the index's 20).
    await identityMirrorAt(sqlExecutor, 20);
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
    const logged = await changeLog();
    const again = await run();
    expect(again.report.groups).toMatchObject({ mirrored: 0, unchanged: 1 });
    expect(again.report.waves).toMatchObject({ mirrored: 0, unchanged: 1 });
    // Its lists, read again, resolve as written: no write, no change logged.
    expect(again.report.remap).toMatchObject({ skipped: null, groups: 0 });
    expect(await dumpTables(sqlExecutor, TABLES)).toEqual(first);
    expect(await changeLog()).toEqual(logged);
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

  /** The profile id an address's identities row holds, through its mapping. */
  const profileIdOf = async (address: string) =>
    (
      await sqlExecutor.execute<{ profile_id: string | null }>(
        `select i.profile_id from ${IDENTITIES_TABLE} i
           join ${ADDRESS_CONSOLIDATION_KEY} a on a.consolidation_key = i.consolidation_key
          where a.address = :address`,
        { address }
      )
    ).map((r) => r.profile_id);

  const groupsHeldRow = () =>
    sqlExecutor.execute<{
      held_since: number | string;
      held_height: number | string;
      held_count: number;
      // The repo's type caster reads a TINYINT column as a boolean.
      held_reported: boolean;
    }>(
      `select held_since, held_height, held_count, held_reported
         from ${WAVES_CHAIN_MIRROR_STATE_TABLE} where name = 'groups_held'`
    );

  it.each(['live', 'rebuild'] as const)(
    "%s: holds a group listing an address until the identity mirror stands at the group's height, then writes it",
    async (mode) => {
      const store =
        mode === 'live'
          ? objectsDb
          : new WavesChainObjectsDb(() => sqlExecutor, 'rebuild');
      await ensurePrincipalMap(sqlExecutor);
      await mapPrincipals(sqlExecutor, { [P1]: 'profile-1' });
      await identityMirrorAt(sqlExecutor, 19);
      await seedGroup(
        aChainGroupRow(G, {
          includes: [
            { kind: 'principal', value: P1 },
            { kind: 'address', value: A2 }
          ]
        })
      );

      const held = await run(undefined, store);
      expect(held.report.groups).toMatchObject({ mirrored: 0, waiting: 1 });
      expect(held.counter.waiting).toEqual({
        group_identity_rows_not_reached: 1
      });
      expect(await groups.getByIdWithoutVisibilityCheck(G)).toBeNull();
      expect(await profileIdOf(A2)).toEqual([]);
      expect(await groupsHeldRow()).toEqual([
        {
          held_since: NOW,
          held_height: 20,
          held_count: 1,
          held_reported: false
        }
      ]);

      await identityMirrorAt(sqlExecutor, 20);
      const released = await run(undefined, store);
      expect(released.report.groups).toMatchObject({ mirrored: 1, waiting: 0 });
      expect(await profileIdOf(A2)).toHaveLength(1);
      expect(await groups.getByIdWithoutVisibilityCheck(G)).not.toBeNull();
      expect(await groupsHeldRow()).toEqual([]);
    }
  );

  it('keeps when a hold began across runs, marks it reported, and starts again after it clears', async () => {
    const full = (count: number, oldestHeight: number | null) => ({
      count,
      oldestHeight,
      complete: true
    });
    expect(await objectsDb.groupsHeld(full(2, 25), NOW)).toEqual({
      since: NOW,
      reported: false,
      count: 2,
      oldestHeight: 25
    });
    expect(await objectsDb.groupsHeld(full(1, 30), NOW + 1_000)).toEqual({
      since: NOW,
      reported: false,
      count: 1,
      oldestHeight: 30
    });
    expect(await groupsHeldRow()).toEqual([
      { held_since: NOW, held_height: 30, held_count: 1, held_reported: false }
    ]);
    await objectsDb.groupsHeldReported();
    expect(await objectsDb.groupsHeld(full(1, 30), NOW + 2_000)).toEqual({
      since: NOW,
      reported: true,
      count: 1,
      oldestHeight: 30
    });
    expect(await objectsDb.groupsHeld(full(0, null), NOW + 3_000)).toBeNull();
    expect(await groupsHeldRow()).toEqual([]);
    expect(await objectsDb.groupsHeld(full(1, 40), NOW + 4_000)).toEqual({
      since: NOW + 4_000,
      reported: false,
      count: 1,
      oldestHeight: 40
    });
  });

  it("keeps a hold's count and oldest height through a run that didn't look at every group", async () => {
    const partial = (count: number, oldestHeight: number) => ({
      count,
      oldestHeight,
      complete: false
    });
    // No hold yet: the run's own count starts it.
    expect(await objectsDb.groupsHeld(partial(1, 30), NOW)).toEqual({
      since: NOW,
      reported: false,
      count: 1,
      oldestHeight: 30
    });
    await objectsDb.groupsHeld(
      { count: 2, oldestHeight: 25, complete: true },
      NOW + 1_000
    );
    expect(await objectsDb.groupsHeld(partial(1, 30), NOW + 2_000)).toEqual({
      since: NOW,
      reported: false,
      count: 2,
      oldestHeight: 25
    });
    expect(await groupsHeldRow()).toEqual([
      { held_since: NOW, held_height: 25, held_count: 2, held_reported: false }
    ]);
  });

  it('finds the addresses mapped to another identities row', async () => {
    // OWN: mapped to its own row. ELSEWHERE: mapped to a row of two wallets.
    const [OWN, ELSEWHERE] = ['c5', 'c6'].map((b) => `0x${b.repeat(20)}`);
    await sqlExecutor.execute(
      `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
       values (:own, :own), (:elsewhere, :pair)`,
      { own: OWN, elsewhere: ELSEWHERE, pair: `${ELSEWHERE}-${A1}` }
    );
    expect(
      Array.from(
        await objectsDb.addressesMappedElsewhere([
          OWN,
          ELSEWHERE.toUpperCase().replace('0X', '0x'),
          A2
        ])
      )
    ).toEqual([ELSEWHERE]);
  });

  it.each([
    ['report-only', false],
    ['writing', true]
  ])(
    '%s: waits with a group listing a wallet of an identity of several wallets without a profile id, writing nothing',
    async (_, write) => {
      const PAIR = `${A2}-0x${'c7'.repeat(20)}`;
      await ensurePrincipalMap(sqlExecutor);
      await mapPrincipals(sqlExecutor, { [P1]: 'profile-1' });
      await identityMirrorAt(sqlExecutor, 20);
      await sqlExecutor.execute(
        `insert into ${IDENTITIES_TABLE}
           (profile_id, consolidation_key, primary_address, tdh, rep, cic, level_raw)
         values (null, :pair, :a, 0, 0, 0, 0)`,
        { pair: PAIR, a: A2 }
      );
      await sqlExecutor.execute(
        `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
         values (:a, :pair)`,
        { pair: PAIR, a: A2 }
      );
      await seedGroup(
        aChainGroupRow(G, {
          includes: [
            { kind: 'address', value: A1 },
            { kind: 'address', value: A2 }
          ]
        })
      );
      const { report, counter } = await run(undefined, objectsDb, write);
      expect(report.groups).toMatchObject({ mirrored: 0, waiting: 1 });
      expect(counter.waiting).toEqual({ group_address_without_profile: 1 });
      expect(counter.changes).toEqual({});
      expect(await groups.getByIdWithoutVisibilityCheck(G)).toBeNull();
      expect(await profileIdOf(A1)).toEqual([]);
    }
  );

  it("counts as updates only the own rows without a profile id that the identities' write gives one", async () => {
    // MAPPED: its own row, mapped to it. UNMAPPED: its own row, no mapping.
    // ELSEWHERE: its own row, but mapped to another row, so it is left alone.
    const [MAPPED, UNMAPPED, ELSEWHERE] = ['c1', 'c2', 'c3'].map(
      (b) => `0x${b.repeat(20)}`
    );
    const other = `${ELSEWHERE}-0x${'c4'.repeat(20)}`;
    for (const key of [MAPPED, UNMAPPED, ELSEWHERE]) {
      await sqlExecutor.execute(
        `insert into ${IDENTITIES_TABLE}
           (profile_id, consolidation_key, primary_address, tdh, rep, cic, level_raw)
         values (null, :key, :key, 0, 0, 0, 0)`,
        { key }
      );
    }
    await sqlExecutor.execute(
      `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
       values (:mapped, :mapped), (:elsewhere, :other)`,
      { mapped: MAPPED, elsewhere: ELSEWHERE, other }
    );
    expect(
      Array.from(
        await objectsDb.ownRowsWithoutProfile([MAPPED, UNMAPPED, ELSEWHERE, A1])
      ).sort()
    ).toEqual([MAPPED, UNMAPPED].sort());
  });

  describe('across switch-on', () => {
    const SWITCH_ON = '2026-11-28T00:00:00Z';
    const switchOn = Date.parse(SWITCH_ON);
    const B1 = `0x${'b1'.repeat(20)}`;
    const B2 = `0x${'b2'.repeat(20)}`;
    const G2 = chainWord('0d');
    const UUID_V4 =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const saved = {
      at: process.env.IDENTITY_SWITCH_ON_AT,
      flag: process.env.FEATURE_IDENTITY_ON_CHAIN
    };
    beforeEach(() => {
      process.env.IDENTITY_SWITCH_ON_AT = SWITCH_ON;
      delete process.env.FEATURE_IDENTITY_ON_CHAIN;
    });
    afterEach(() => {
      for (const [name, value] of [
        ['IDENTITY_SWITCH_ON_AT', saved.at],
        ['FEATURE_IDENTITY_ON_CHAIN', saved.flag]
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    /** Groups listing B1 a minute before switch-on and B2 a minute after. */
    const seedBoth = async () => {
      await ensurePrincipalMap(sqlExecutor);
      await mapPrincipals(sqlExecutor, { [P1]: 'profile-1' });
      await identityMirrorAt(sqlExecutor, 20);
      await seedGroup(
        aChainGroupRow(
          G,
          { includes: [{ kind: 'address', value: B1 }] },
          { controller: P1, activeFrom: switchOn - 60_000 }
        )
      );
      await seedGroup(
        aChainGroupRow(
          G2,
          { includes: [{ kind: 'address', value: B2 }] },
          { controller: P1, activeFrom: switchOn + 60_000 }
        )
      );
    };

    it("gives each listed address the id of its group's side of switch-on, the same in a rebuild of a mirror that caught up", async () => {
      // The live mirror catches up over both groups in one run.
      await seedBoth();
      const live = await run();
      expect(live.report.groups).toMatchObject({ mirrored: 2, failed: 0 });
      const [liveB1] = await profileIdOf(B1);
      const [liveB2] = await profileIdOf(B2);
      expect(liveB1).toMatch(UUID_V4);
      expect(liveB2).toBe(addressIdentityId(B2));

      // The rebuild, from the chain alone.
      await clearMirrorTables(sqlExecutor);
      await seedBoth();
      const rebuilt = await run(
        undefined,
        new WavesChainObjectsDb(() => sqlExecutor, 'rebuild')
      );
      expect(rebuilt.report.groups).toMatchObject({ mirrored: 2, failed: 0 });
      const [rebuiltB1] = await profileIdOf(B1);
      expect(rebuiltB1).toMatch(UUID_V4);
      expect(rebuiltB1).not.toBe(addressIdentityId(B1));
      expect(await profileIdOf(B2)).toEqual([liveB2]);
    });

    it('counts a group written at the switch-on instant as switched on', async () => {
      const B3 = `0x${'b3'.repeat(20)}`;
      await ensurePrincipalMap(sqlExecutor);
      await mapPrincipals(sqlExecutor, { [P1]: 'profile-1' });
      await identityMirrorAt(sqlExecutor, 20);
      await seedGroup(
        aChainGroupRow(
          G,
          { includes: [{ kind: 'address', value: B3 }] },
          { controller: P1, activeFrom: switchOn }
        )
      );
      const { report } = await run();
      expect(report.groups).toMatchObject({ mirrored: 1, failed: 0 });
      expect(await profileIdOf(B3)).toEqual([addressIdentityId(B3)]);
    });

    it("turns a listed address's own row without a profile id into its derived one, never a second row", async () => {
      await seedBoth();
      await sqlExecutor.execute(
        `insert into ${IDENTITIES_TABLE}
           (profile_id, consolidation_key, primary_address, tdh, rep, cic, level_raw)
         values (null, :a, :a, 0, 0, 0, 0)`,
        { a: B2 }
      );
      await sqlExecutor.execute(
        `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
         values (:a, :a)`,
        { a: B2 }
      );
      const { report } = await run();
      expect(report.groups).toMatchObject({ mirrored: 2, failed: 0 });
      expect(
        await sqlExecutor.execute(
          `select profile_id from ${IDENTITIES_TABLE} where primary_address = :a`,
          { a: B2 }
        )
      ).toEqual([{ profile_id: addressIdentityId(B2) }]);
      expect(
        await sqlExecutor.execute(
          `select profile_id from ${PROFILE_GROUPS_TABLE} where profile_id is null`
        )
      ).toEqual([]);
    });

    describe('member lists that follow wallet bindings', () => {
      /** Identity Z's principal, profile and first wallet. */
      const PZ = chainWord('5a');
      const Z = 'profile-z';
      const WZ = `0x${'5a'.repeat(20)}`;
      /** A wallet the groups list, unbound when they are written. */
      const B = `0x${'b4'.repeat(20)}`;
      const identity = new IdentityChainMirrorDb(() => sqlExecutor);
      const INCLUDE = groupListId(G, 1, 'include');
      const INCLUDE2 = groupListId(G2, 1, 'include');

      beforeEach(async () => {
        for (const table of [PROFILES_TABLE, CONSOLIDATIONS_TABLE]) {
          await sqlExecutor.execute(`delete from ${table}`);
        }
      });

      /** The identity mirror's write of Z holding `wallets`. */
      const bindZ = (wallets: string[], eventTime = switchOn + 120_000) =>
        sqlExecutor.executeNativeQueriesInTransaction(async (conn) => {
          const state = await identity.readIdentityState(
            wallets,
            Z,
            null,
            WZ,
            conn
          );
          const plan = planIdentity(
            {
              principalId: PZ,
              profileId: Z,
              handle: null,
              wallets,
              primary: WZ,
              doc: { ...EMPTY_PROFILE_DOC_FIELDS },
              rep: 0,
              cic: 0,
              levelRaw: 0
            },
            state
          );
          await identity.applyIdentityPlan(plan, 1, NOW, conn, () => eventTime);
        });

      /** G lists B; G2 lists Z's principal and B. */
      const seedGroups = async () => {
        await ensurePrincipalMap(sqlExecutor);
        await mapPrincipals(sqlExecutor, { [P1]: 'profile-1', [PZ]: Z });
        await identityMirrorAt(sqlExecutor, 20);
        await bindZ([WZ], switchOn + 30_000);
        const at = { controller: P1, activeFrom: switchOn + 60_000 };
        await seedGroup(
          aChainGroupRow(G, { includes: [{ kind: 'address', value: B }] }, at)
        );
        await seedGroup(
          aChainGroupRow(
            G2,
            {
              includes: [
                { kind: 'principal', value: PZ },
                { kind: 'address', value: B }
              ]
            },
            at
          )
        );
      };
      const listOf = async (listId: string) =>
        (
          await sqlExecutor.execute<{ profile_id: string }>(
            `select profile_id from ${PROFILE_GROUPS_TABLE}
              where profile_group_id = :listId order by profile_id`,
            { listId }
          )
        ).map((r) => r.profile_id);
      const rowsOf = async () => ({
        lists: await sqlExecutor.execute(
          `select profile_group_id, profile_id from ${PROFILE_GROUPS_TABLE}
            order by profile_group_id, profile_id`
        ),
        identities: await sqlExecutor.execute(
          `select consolidation_key, profile_id, primary_address
             from ${IDENTITIES_TABLE} order by consolidation_key`
        ),
        keys: await sqlExecutor.execute(
          `select address, consolidation_key from ${ADDRESS_CONSOLIDATION_KEY}
            order by address`
        )
      });

      it('moves a listed wallet to the identity it joins and back to its own row when it leaves, making no row; a rebuild gives the same rows', async () => {
        await seedGroups();
        expect((await run()).report.groups).toMatchObject({
          mirrored: 2,
          failed: 0
        });
        // Unbound: the groups' write gave B its own row.
        const own = addressIdentityId(B);
        expect(await profileIdOf(B)).toEqual([own]);
        expect(await listOf(INCLUDE)).toEqual([own]);
        expect(await listOf(INCLUDE2)).toEqual([own, Z].sort());

        // B joins Z: its own row goes, and the lists follow it.
        await bindZ([WZ, B]);
        const logged = (await changeLog()).length;
        const joined = await run();
        expect(joined.report.remap).toMatchObject({
          groups: 2,
          include: { added: 1, removed: 2 }
        });
        expect(await listOf(INCLUDE)).toEqual([Z]);
        // Z stays in G2 by its principal; only B's own row goes.
        expect(await listOf(INCLUDE2)).toEqual([Z]);
        // Each group's change is logged by three writers in turn: with its
        // lists, inside their transaction (rewriteGroupLists,
        // objects.db.ts:1048); again after the commit (groupsChanged,
        // objects.effects.ts:24); then every current member of the list, by
        // 6529.io's cache clear for a group of an include list alone
        // (objects.effects.ts:25, user-groups.service.ts:2065 and
        // :2007-2023).
        expect(
          (await changeLog()).slice(logged).map((r) => r.profile_id)
        ).toEqual([
          // G: inside the transaction, after the commit, its members.
          Z,
          own,
          Z,
          own,
          Z,
          // G2: inside the transaction, after the commit, its members.
          own,
          own,
          Z
        ]);

        // B leaves Z at a later block: the identity mirror gives it its own
        // row again, by the removal's time; the lists follow, and the waves
        // mirror makes no row of its own.
        await bindZ([WZ], switchOn + 180_000);
        expect(await profileIdOf(B)).toEqual([own]);
        const left = await run();
        expect(left.report.remap).toMatchObject({
          groups: 2,
          include: { added: 2, removed: 1 }
        });
        expect(await listOf(INCLUDE)).toEqual([own]);
        expect(await listOf(INCLUDE2)).toEqual([own, Z].sort());
        expect(
          await sqlExecutor.execute(
            `select profile_id from ${IDENTITIES_TABLE} where primary_address = :b`,
            { b: B }
          )
        ).toEqual([{ profile_id: own }]);
        const live = await rowsOf();

        // A rebuild at the same bindings: the identity mirror's rows first,
        // then the groups, resolved once.
        await clearMirrorTables(sqlExecutor);
        await sqlExecutor.execute(`delete from ${PROFILES_TABLE}`);
        await sqlExecutor.execute(`delete from ${CONSOLIDATIONS_TABLE}`);
        await seedGroups();
        await bindZ([WZ, B]);
        await bindZ([WZ], switchOn + 180_000);
        const rebuilt = await run(
          undefined,
          new WavesChainObjectsDb(() => sqlExecutor, 'rebuild')
        );
        expect(rebuilt.report.groups).toMatchObject({ mirrored: 2, failed: 0 });
        expect(await rowsOf()).toEqual(live);
      });

      it('takes the group from the whole identity an excluded wallet joins', async () => {
        await ensurePrincipalMap(sqlExecutor);
        await mapPrincipals(sqlExecutor, { [P1]: 'profile-1' });
        await identityMirrorAt(sqlExecutor, 20);
        await bindZ([WZ], switchOn + 30_000);
        // Everyone but B.
        await seedGroup(
          aChainGroupRow(
            G,
            {
              predicateMode: 'all_clauses',
              excludes: [{ kind: 'address', value: B }]
            },
            { controller: P1, activeFrom: switchOn + 60_000 }
          )
        );
        // A wave that reads and is administered with G: eligibility looks
        // only at the groups waves, decisions and curations use.
        const cid = await seedDocument(aWaveDoc());
        await seedWave(
          aChainWaveRow(W, { read: G, admin: G, metadataCid: cid })
        );
        await index.writeEvents([waveCreated(W)], 21, UNKNOWN_SCAN);
        await run();
        expect((await waves.findWaveById(W))?.visibility_group_id).toBe(G);
        expect(await userGroupsService.getGroupsUserIsEligibleFor(Z)).toContain(
          G
        );

        await bindZ([WZ, B]);
        await run();
        expect(await listOf(groupListId(G, 1, 'exclude'))).toEqual([Z]);
        expect(
          await userGroupsService.getGroupsUserIsEligibleFor(Z)
        ).not.toContain(G);
      });

      it('reads no list while the identity mirror is behind, holding nothing; then counts a report-only run and writes', async () => {
        await seedGroups();
        await run();
        await bindZ([WZ, B]);
        const before = await rowsOf();

        await identityMirrorAt(sqlExecutor, 19);
        const behind = await run();
        expect(behind.report.remap.skipped).toBe('identity_rows_not_reached');
        expect(behind.counter.waiting).toEqual({});
        expect(await groupsHeldRow()).toEqual([]);
        expect(await rowsOf()).toEqual(before);

        await identityMirrorAt(sqlExecutor, 20);
        const dry = await run(undefined, objectsDb, false);
        expect(dry.report.remap).toMatchObject({
          skipped: null,
          groups: 2,
          include: { added: 1, removed: 2 }
        });
        expect(dry.counter.changes).toEqual({
          profile_groups: { insert: 1, update: 0, delete: 2 }
        });
        expect(await rowsOf()).toEqual(before);

        const writing = await run();
        expect(writing.report.remap).toEqual(dry.report.remap);
        expect(await listOf(INCLUDE)).toEqual([Z]);
      });

      it('finishes in the next run the group a run had no time for, writing none twice', async () => {
        await seedGroups();
        await run();
        await bindZ([WZ, B]);
        const logged = (await changeLog()).length;
        // Time runs out once G's lists are written: G2's have no time left.
        const written = jest.spyOn(objectsDb, 'rewriteGroupLists');
        const cut = await run(
          undefined,
          objectsDb,
          true,
          () => written.mock.calls.length > 0
        );
        written.mockRestore();
        expect(cut.report.remap).toMatchObject({ groups: 2, left: 1 });
        expect(await listOf(INCLUDE)).toEqual([Z]);
        expect(await listOf(INCLUDE2)).toEqual(
          [addressIdentityId(B), Z].sort()
        );
        const next = await run();
        expect(next.report.remap).toMatchObject({ groups: 1, left: 0 });
        expect(await listOf(INCLUDE2)).toEqual([Z]);
        const own = addressIdentityId(B);
        // Each group written once, its change logged by the three writers:
        // inside the transaction (objects.db.ts:1048), after the commit
        // (objects.effects.ts:24), and its list's current members
        // (objects.effects.ts:25, user-groups.service.ts:2065 and
        // :2007-2023).
        expect(
          (await changeLog()).slice(logged).map((r) => r.profile_id)
        ).toEqual([
          // G, in the run cut short.
          Z,
          own,
          Z,
          own,
          Z,
          // G2, in the next run.
          own,
          own,
          Z
        ]);
        expect((await run()).report.remap.groups).toBe(0);
      });

      it("stops a profile posting in a wave's chat on the first read after the lists drop it", async () => {
        await seedGroups();
        // A wave whose chat group is G.
        const cid = await seedDocument(aWaveDoc());
        await seedWave(
          aChainWaveRow(W, { post: G, admin: G, metadataCid: cid })
        );
        await index.writeEvents([waveCreated(W)], 21, UNKNOWN_SCAN);
        await bindZ([WZ, B]);
        await run();
        const wave = await waves.findWaveById(W);
        expect(wave?.chat_group_id).toBe(G);
        // As drop creation asks: Z may post, by B. Database tests run with
        // Redis off, so nothing is cached here: this shows the lists' change
        // reaching eligibility. The cache is tested apart, in
        // waves-chain-mirror.eligibility.test.ts.
        expect(await userGroupsService.getGroupsUserIsEligibleFor(Z)).toContain(
          wave!.chat_group_id
        );
        const logged = (await changeLog()).length;

        // B leaves Z: G's list drops Z.
        await bindZ([WZ], switchOn + 180_000);
        await run();
        expect(await listOf(INCLUDE)).toEqual([addressIdentityId(B)]);
        // Z's rows: G's change inside its transaction (objects.db.ts:1048)
        // and after the commit (objects.effects.ts:24), the row that ends
        // an answer cached for Z before the commit; then G2's members, Z
        // among them by its principal (objects.effects.ts:25,
        // user-groups.service.ts:2065 and :2007-2023).
        expect(
          (await changeLog()).slice(logged).filter((r) => r.profile_id === Z)
        ).toHaveLength(3);
        expect(
          await userGroupsService.getGroupsUserIsEligibleFor(Z)
        ).not.toContain(wave!.chat_group_id);
      });

      it("brings an imported group's own lists to the chain's members, leaving a group of principals alone and one the chain holds as a static list, then follows its wallet", async () => {
        const GI = chainWord('1e');
        const GO = chainWord('1f');
        const GS = chainWord('1d');
        const LEGACY_OTHER = '6f1c2a5e-3b4d-4e8f-9a0b-1c2d3e4f5a6c';
        const OTHER_ID = `others-${groupShortIdOf(LEGACY_OTHER)}`;
        const LEGACY_HOLDERS = '6f1c2a5e-3b4d-4e8f-9a0b-1c2d3e4f5a6d';
        const HOLDERS_ID = `holders-${groupShortIdOf(LEGACY_HOLDERS)}`;
        /** The id 6529.io gave B's own row before switch-on. */
        const PRE = '00000000-0000-4000-8000-0000000000b4';
        await ensurePrincipalMap(sqlExecutor);
        await mapPrincipals(sqlExecutor, { [P1]: 'profile-1', [PZ]: Z });
        await identityMirrorAt(sqlExecutor, 20);
        await bindZ([WZ], switchOn + 30_000);
        await sqlExecutor.execute(
          `insert into ${IDENTITIES_TABLE}
             (profile_id, consolidation_key, primary_address, tdh, rep, cic, level_raw)
           values (:pre, :b, :b, 0, 0, 0, 0)`,
          { pre: PRE, b: B }
        );
        await sqlExecutor.execute(
          `insert into ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
           values (:b, :b)`,
          { b: B }
        );
        // 6529.io's imported groups, each with its own list: B's row and a
        // profile only 6529.io lists, without Z's principal; and a group of
        // principals alone, drifted the same way.
        for (const [id, listId] of [
          [IMPORTED_GROUP_ID, 'readers-include'],
          [OTHER_ID, 'others-include']
        ]) {
          await groups.save(
            groupRowOf({
              id,
              name: 'Readers',
              createdAt: new Date(CREATED_AT),
              createdBy: 'profile-1',
              criteria: NO_CRITERIA,
              repUser: null,
              includeListId: listId,
              excludeListId: null,
              visible: true,
              isPrivate: false
            }),
            undefined as never
          );
        }
        // A criteria group (TDH of 100 or more) with an explicit include
        // list, which the chain holds as the freeze's list of its members.
        await groups.save(
          groupRowOf({
            id: HOLDERS_ID,
            name: 'Holders',
            createdAt: new Date(CREATED_AT),
            createdBy: 'profile-1',
            criteria: { ...NO_CRITERIA, tdh_min: 100 },
            repUser: null,
            includeListId: 'holders-include',
            excludeListId: null,
            visible: true,
            isPrivate: false
          }),
          undefined as never
        );
        await sqlExecutor.execute(
          `insert into ${PROFILE_GROUPS_TABLE} (profile_group_id, profile_id)
           values ('readers-include', :pre), ('readers-include', 'profile-only-here'),
                  ('others-include', 'profile-only-here'),
                  ('holders-include', 'profile-explicit')`,
          { pre: PRE }
        );
        // The chain's version 1 of both.
        const imported = { origin: 'legacy', controller: P1 };
        await seedGroup(
          aChainGroupRow(
            GI,
            {
              includes: [
                { kind: 'principal', value: PZ },
                { kind: 'address', value: B }
              ]
            },
            { ...imported, legacyId: LEGACY_GROUP }
          )
        );
        await seedGroup(
          aChainGroupRow(
            GO,
            { includes: [{ kind: 'principal', value: PZ }] },
            { ...imported, legacyId: LEGACY_OTHER }
          )
        );
        await seedGroup(
          aChainGroupRow(
            GS,
            {
              includes: [
                { kind: 'principal', value: PZ },
                { kind: 'address', value: B }
              ]
            },
            { ...imported, legacyId: LEGACY_HOLDERS }
          )
        );

        const first = await run();
        expect(first.report.remap).toMatchObject({
          groups: 0,
          imported: {
            groups: 1,
            include: { added: 1, removed: 1 },
            capped: false,
            unmatched: 0,
            skippedStatic: 1
          }
        });
        expect(await listOf('readers-include')).toEqual([PRE, Z].sort());
        expect(await listOf('others-include')).toEqual(['profile-only-here']);
        expect(await listOf('holders-include')).toEqual(['profile-explicit']);
        // The match is kept; the row itself is 6529.io's, as it was.
        expect((await objectsDb.mirroredGroups([GI])).get(GI)).toMatchObject({
          groupId: IMPORTED_GROUP_ID,
          version: null
        });
        expect((await objectsDb.mirroredGroups([GO])).has(GO)).toBe(false);
        expect(
          await groups.getByIdWithoutVisibilityCheck(IMPORTED_GROUP_ID)
        ).toMatchObject({
          name: 'Readers',
          profile_group_id: 'readers-include'
        });
        // No row of its own for B, which has 6529.io's.
        expect(await profileIdOf(B)).toEqual([PRE]);

        // B joins Z after switch-on: the list follows it.
        await bindZ([WZ, B]);
        await run();
        expect(await listOf('readers-include')).toEqual([Z]);
        expect(await listOf('holders-include')).toEqual(['profile-explicit']);
      });
    });
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
