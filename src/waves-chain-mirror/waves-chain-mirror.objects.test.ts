import { UserGroupEntity } from '@/entities/IUserGroup';
import { BadRequestException } from '@/exceptions';
import {
  aChainDecisionRow,
  aChainGroupRow,
  aDecisionDoc,
  aChainWaveRow,
  aWaveDoc,
  aWaveRow,
  chainWord,
  FakeDocuments,
  fakeObjectEffects,
  FakeObjectsStore
} from '@/tests/fixtures/waves-chain-mirror.objects.fixture';
import { DOC_CLASS, docCommitment } from './waves-chain-mirror.docs';
import { ContentGate, GateVerdict } from './waves-chain-mirror.gate';
import {
  groupListId,
  groupShortIdOf,
  legacyUuidOfGroupId,
  nativeCompetitionId,
  readLegacyId,
  waveDescriptionDropId
} from './waves-chain-mirror.ids';
import {
  PARENT_WAIT_MS,
  WavesChainObjectsMirror
} from './waves-chain-mirror.objects';
import { PlanCounter, retryDelayMs } from './waves-chain-mirror.plan-support';
import {
  EMPTY_DESCRIPTION,
  waveWrittenKey,
  chainWaveOf
} from './waves-chain-mirror.waves';

const NOW = 1_765_000_000_000;
const G = chainWord('0a');
const W = chainWord('0b');
const P1 = chainWord('11');
const P2 = chainWord('22');
const A1 = `0x${'a1'.repeat(20)}`;
const A2 = `0x${'a2'.repeat(20)}`;
const CID = `0x01551220${'cd'.repeat(32)}`;
const CID2 = `0x01551220${'ce'.repeat(32)}`;
const LEGACY_GROUP = '6f1c2a5e-3b4d-4e8f-9a0b-1c2d3e4f5a6b';
const LEGACY_WAVE = '0b1c2d3e-0000-4000-8000-0000000000aa';
const IMPORTED_GROUP_ID = `readers-${groupShortIdOf(LEGACY_GROUP)}`;

function world() {
  const store = new FakeObjectsStore();
  const effects = fakeObjectEffects();
  const documents = new FakeDocuments();
  const verdicts: GateVerdict[] = [];
  const gate: ContentGate & { check: jest.Mock } = {
    check: jest.fn(
      async (): Promise<GateVerdict> => verdicts.shift() ?? { kind: 'allowed' }
    )
  };
  const principals = new Map([
    [P1, 'profile-1'],
    [P2, 'profile-2']
  ]);
  let now = NOW;
  const mirror = new WavesChainObjectsMirror(
    store,
    async (ids) =>
      new Map(
        ids
          .filter((id) => principals.has(id))
          .map((id) => [id, principals.get(id)!])
      ),
    effects,
    gate,
    () => now
  );
  const run = async (write = true, outOfTime = () => false) => {
    const counter = new PlanCounter();
    const report = await mirror.run({
      write,
      documents,
      counter,
      outOfTime
    });
    return { report, counter };
  };
  return {
    store,
    effects,
    documents,
    verdicts,
    gate,
    principals,
    run,
    at: (time: number) => {
      now = time;
    }
  };
}

describe('WavesChainObjectsMirror: groups', () => {
  it('writes a group made on the chain once, with its lists, and passes over it after', async () => {
    const { store, effects, run } = world();
    store.addressProfiles.set(A1, 'profile-a1');
    store.chainGroups = [
      aChainGroupRow(G, {
        includes: [
          { kind: 'principal', value: P2 },
          { kind: 'address', value: A1 },
          { kind: 'address', value: A2 }
        ]
      })
    ];
    const { report, counter } = await run();
    expect(report.groups).toMatchObject({ mirrored: 1, waiting: 0 });
    expect(store.addedIdentities).toEqual([A2]);
    expect(store.groupWrites).toHaveLength(1);
    const [write] = store.groupWrites;
    expect(write.replaces).toBe(false);
    expect(write.row).toMatchObject({
      id: G,
      name: `Group ${G.slice(0, 10)}`,
      created_by: 'profile-1',
      created_at: new Date(1_764_000_000_000),
      visible: true,
      profile_group_id: groupListId(G, 1, 'include'),
      excluded_profile_group_id: null,
      tdh_min: null
    });
    expect(write.includes).toEqual([
      'profile-2',
      'profile-a1',
      `profile-of-${A2.slice(2, 8)}`
    ]);
    expect(store.groupRecords.get(G)).toMatchObject({ groupId: G, version: 1 });
    expect(effects.groupsChanged).toHaveBeenCalledWith([G], write.includes);
    expect(counter.changes).toMatchObject({
      community_groups: { insert: 1 },
      profile_groups: { insert: 3 },
      identities: { insert: 1 }
    });

    const again = await run();
    expect(again.report.groups).toMatchObject({ mirrored: 0, unchanged: 1 });
    expect(store.groupWrites).toHaveLength(1);
  });

  it('waits with a group whose member has no profile yet', async () => {
    const { store, run } = world();
    store.chainGroups = [
      aChainGroupRow(G, {
        includes: [{ kind: 'principal', value: chainWord('99') }]
      })
    ];
    const { report, counter } = await run();
    expect(report.groups.waiting).toBe(1);
    expect(counter.waiting).toEqual({ group_member_unmapped: 1 });
    expect(store.writes()).toBe(0);
  });

  it('makes no identity for a listed address in a rebuild: it waits for the identity area', async () => {
    const { store, run } = world();
    store.mode = 'rebuild';
    store.chainGroups = [
      aChainGroupRow(G, { includes: [{ kind: 'address', value: A2 }] })
    ];
    const first = await run();
    expect(first.report.groups.waiting).toBe(1);
    expect(first.counter.waiting).toEqual({
      group_address_identity_missing: 1
    });
    expect(store.addedIdentities).toEqual([]);
    expect(store.writes()).toBe(0);

    // Once the identity area has it, the group is written.
    store.addressProfiles.set(A2, 'profile-a2');
    const second = await run();
    expect(second.report.groups.mirrored).toBe(1);
    expect(store.groupWrites[0].includes).toEqual(['profile-a2']);
    expect(store.addedIdentities).toEqual([]);
  });

  it('rewrites an imported group the chain replaced in place, keeping its name and dropping its old lists', async () => {
    const { store, run } = world();
    store.importedGroups.set(LEGACY_GROUP, IMPORTED_GROUP_ID);
    store.groups.set(IMPORTED_GROUP_ID, {
      id: IMPORTED_GROUP_ID,
      name: 'Readers',
      created_at: new Date(1_700_000_000_000),
      created_by: 'group-creator',
      visible: true,
      is_private: false,
      profile_group_id: 'old-list',
      excluded_profile_group_id: null,
      owns_meme: true
    } as unknown as UserGroupEntity);
    store.chainGroups = [
      aChainGroupRow(
        G,
        {
          predicateMode: 'all_clauses',
          clauses: [
            {
              metric: 'tdh',
              metricCode: 1,
              category: null,
              rater: null,
              min: '1000',
              max: String(Number.MAX_SAFE_INTEGER)
            }
          ]
        },
        { version: 2, origin: 'legacy', legacyId: LEGACY_GROUP }
      )
    ];
    const { report } = await run();
    expect(report.groups.mirrored).toBe(1);
    const [write] = store.groupWrites;
    expect(write.replaces).toBe(true);
    expect(write.row).toMatchObject({
      id: IMPORTED_GROUP_ID,
      name: 'Readers',
      created_at: new Date(1_700_000_000_000),
      created_by: 'profile-1',
      tdh_min: 1000,
      tdh_max: null,
      owns_meme: false,
      profile_group_id: null
    });
    expect(write.oldListIds).toEqual(['old-list']);
    expect(store.groupRecords.get(G)).toMatchObject({
      groupId: IMPORTED_GROUP_ID,
      version: 2
    });
  });

  it('leaves an imported group the chain never replaced as 6529.io has it', async () => {
    const { store, run } = world();
    store.chainGroups = [
      aChainGroupRow(G, {}, { origin: 'legacy', legacyId: LEGACY_GROUP })
    ];
    const { report } = await run();
    expect(report.groups).toMatchObject({ mirrored: 0, unchanged: 0 });
    expect(store.writes()).toBe(0);
  });
});

describe("WavesChainObjectsMirror: a rebuild's imported wave", () => {
  const imported = (descriptionDropId: unknown) => {
    const w = world();
    w.store.mode = 'rebuild';
    w.store.chainWaves = [
      aChainWaveRow(chainWord('0c'), {
        origin: 'legacy',
        legacyId: LEGACY_WAVE,
        controller: P1,
        metadataCid: CID2
      })
    ];
    w.documents.put(CID2, aWaveDoc({ description_drop_id: descriptionDropId }));
    w.store.descriptionDropIds.set(LEGACY_WAVE, 'from-the-mapping');
    return w;
  };

  it("takes its description drop id from its document, a malformed one noted and the mapping's used", async () => {
    const valid = imported('00000000-0000-4000-8000-0000000001b1');
    await valid.run();
    expect(valid.store.importedWaves[0].description_drop_id).toBe(
      '00000000-0000-4000-8000-0000000001b1'
    );

    for (const bad of ['', 'not-a-uuid']) {
      const w = imported(bad);
      const { counter } = await w.run();
      // Noted, not waiting: the wave is written.
      expect(counter.notes).toEqual({ wave_description_drop_id_invalid: 1 });
      expect(counter.waiting.wave_description_drop_id_invalid).toBeUndefined();
      expect(w.store.importedWaves[0].description_drop_id).toBe(
        'from-the-mapping'
      );
    }

    // A dry run shows it too.
    const dry = imported('not-a-uuid');
    const { counter: dryCounter } = await dry.run(false);
    expect(dryCounter.notes).toEqual({ wave_description_drop_id_invalid: 1 });
    expect(dry.store.importedWaves).toEqual([]);

    // No field: the mapping, nothing noted.
    const none = imported(undefined);
    const { counter } = await none.run();
    expect(counter.notes).toEqual({});
    expect(none.store.importedWaves[0].description_drop_id).toBe(
      'from-the-mapping'
    );
  });

  it("checks the document's id against the drops the drop archives' import wrote", async () => {
    const id = '00000000-0000-4000-8000-0000000001b1';
    // A drop of the wave: written.
    const found = imported(id);
    found.store.archivedDrops = new Map([[id, LEGACY_WAVE]]);
    const first = await found.run();
    expect(first.counter.notes).toEqual({});
    expect(found.store.importedWaves[0].description_drop_id).toBe(id);
    // No such drop, or another wave's: noted, the mapping's used.
    for (const drops of [new Map<string, string>(), new Map([[id, 'other']])]) {
      const w = imported(id);
      w.store.archivedDrops = drops;
      const { counter } = await w.run();
      expect(counter.notes).toEqual({ wave_description_drop_id_invalid: 1 });
      expect(w.store.importedWaves[0].description_drop_id).toBe(
        'from-the-mapping'
      );
    }
  });
});

describe("WavesChainObjectsMirror: a rebuild's imported groups", () => {
  it('matches every imported group the chain never replaced to its 6529.io row, keeping the match; a live run none', async () => {
    for (const mode of ['live', 'rebuild'] as const) {
      const { store, run } = world();
      store.mode = mode;
      store.importedGroups.set(LEGACY_GROUP, IMPORTED_GROUP_ID);
      store.importedChainGroups = [
        aChainGroupRow(G, {}, { origin: 'legacy', legacyId: LEGACY_GROUP })
      ];
      const { report } = await run();
      // Matched now: counted as mirrored, then unchanged.
      expect(report.groups).toMatchObject(
        mode === 'rebuild'
          ? { mirrored: 1, unchanged: 0, failed: 0 }
          : { mirrored: 0, unchanged: 0, failed: 0 }
      );
      if (mode === 'rebuild') {
        expect((await run()).report.groups).toMatchObject({
          mirrored: 0,
          unchanged: 1
        });
      }
      expect(store.groupRecords.get(G)).toEqual(
        mode === 'rebuild'
          ? expect.objectContaining({
              groupId: IMPORTED_GROUP_ID,
              version: null
            })
          : undefined
      );
      // 6529.io's row stays as it is.
      expect(store.groupWrites).toEqual([]);
    }
  });

  it('leaves the imported groups it has no time for to the next run, and counts one with no row as waiting', async () => {
    const { store, run } = world();
    store.mode = 'rebuild';
    store.importedGroups.set(LEGACY_GROUP, IMPORTED_GROUP_ID);
    store.importedChainGroups = [
      aChainGroupRow(G, {}, { origin: 'legacy', legacyId: LEGACY_GROUP }),
      aChainGroupRow(
        chainWord('0d'),
        {},
        {
          origin: 'legacy',
          legacyId: '0b1c2d3e-0000-4000-8000-0000000000dd'
        }
      )
    ];
    const late = await run(true, () => true);
    expect(late.report.groups).toMatchObject({ left: 2, mirrored: 0 });
    expect(store.groupRecords.size).toBe(0);
    const { report, counter } = await run();
    expect(report.groups).toMatchObject({ mirrored: 1, waiting: 1 });
    expect(counter.waiting).toMatchObject({ imported_group_unmatched: 1 });
  });
});

describe('WavesChainObjectsMirror: an imported group with a hashed legacy id', () => {
  it('mirrors its replacement in either mode: its legacy id is no UUID to check', async () => {
    // The import's legacy id of a 6529.io group id with no short id: the
    // first 16 bytes of keccak256 of the id, not an RFC 4122 UUID.
    const hashed = legacyUuidOfGroupId('an-old-group');
    expect(readLegacyId(hashed).ok).toBe(false);
    for (const mode of ['live', 'rebuild'] as const) {
      const { store, run } = world();
      store.mode = mode;
      store.importedGroups.set(hashed, 'an-old-group');
      store.groups.set('an-old-group', {
        id: 'an-old-group',
        name: 'An old group',
        created_at: new Date(1_700_000_000_000),
        created_by: 'group-creator',
        visible: true,
        is_private: false,
        profile_group_id: 'old-list',
        excluded_profile_group_id: null
      } as unknown as UserGroupEntity);
      store.chainGroups = [
        aChainGroupRow(
          G,
          { includes: [{ kind: 'principal', value: P1 }] },
          { origin: 'legacy', legacyId: hashed, version: 2 }
        )
      ];
      const { report } = await run();
      expect(report.groups).toMatchObject({ mirrored: 1, failed: 0 });
      expect(store.groupRecords.get(G)).toMatchObject({
        groupId: 'an-old-group',
        version: 2
      });
    }
  });
});

describe('WavesChainObjectsMirror: waves', () => {
  /** A group made on the chain, and a wave whose admins and readers it is. */
  function nativeWave(doc = aWaveDoc()) {
    const w = world();
    w.store.chainGroups = [
      aChainGroupRow(G, { includes: [{ kind: 'principal', value: P1 }] })
    ];
    w.store.chainWaves = [
      aChainWaveRow(W, { read: G, admin: G, metadataCid: CID })
    ];
    w.store.events = [
      { kind: 'WAVE_CREATED', id: W, time: 1_764_500_000_000, actor: P1 }
    ];
    w.documents.put(CID, doc);
    return w;
  }

  it('creates a wave made on the chain as 6529.io creates a chat wave, once', async () => {
    const { store, effects, gate, run } = nativeWave();
    const { report, counter } = await run();
    expect(report.waves).toMatchObject({ mirrored: 1, waiting: 0 });
    expect(store.waveCreates).toHaveLength(1);
    const [create] = store.waveCreates;
    expect(effects.newWaveEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        id: W,
        createdAt: 1_764_500_000_000,
        createdBy: 'profile-1',
        descriptionDropId: waveDescriptionDropId(W)
      })
    );
    expect(create.entity).toMatchObject({
      id: W,
      name: 'Made on the chain',
      visibility_group_id: G,
      admin_group_id: G,
      chat_group_id: null,
      chat_enabled: true,
      created_by: 'profile-1'
    });
    expect(create.description).toEqual({
      dropId: waveDescriptionDropId(W),
      authorId: 'profile-1',
      createdAt: 1_764_500_000_000,
      parts: [{ content: 'What this wave is about', media: [] }]
    });
    expect(create.metadata).toEqual({ 'wave_display.rules.custom': 'Be kind' });
    // identity_subscriptions.target_id can't hold a chain id yet.
    expect(create.follow).toBe(false);
    expect(counter.waiting).toEqual({ wave_creator_follow_id_too_long: 1 });
    expect(gate.check).toHaveBeenCalledWith(
      expect.objectContaining({
        dropId: waveDescriptionDropId(W),
        authorProfileId: 'profile-1',
        waveId: W
      })
    );
    expect(effects.waveChanged).toHaveBeenCalledWith({
      waveId: W,
      groupIds: [G, G],
      followerId: 'profile-1'
    });
    expect(counter.changes).toMatchObject({
      waves: { insert: 1 },
      drops: { insert: 1 },
      waves_metadatas: { insert: 1 }
    });
    expect(counter.changes.identity_subscriptions).toBeUndefined();

    const again = await run();
    expect(again.report.waves).toMatchObject({ mirrored: 0, unchanged: 1 });
    expect(store.waveCreates).toHaveLength(1);
  });

  it('waits with a wave until its group is written', async () => {
    const { store, principals, run } = nativeWave();
    principals.delete(P1);
    store.events = [];
    store.chainWaves = [
      aChainWaveRow(W, { read: G, controller: P2, metadataCid: CID })
    ];
    const { report, counter } = await run();
    expect(report.waves.waiting).toBe(1);
    expect(counter.waiting).toMatchObject({
      group_member_unmapped: 1,
      wave_group_not_mirrored: 1
    });
    expect(store.writes()).toBe(0);
  });

  it('keeps a parent wave only when the chain counts the creator its manager', async () => {
    // An imported parent: 6529.io's row under its legacy id, on the chain
    // under its chain id.
    const PARENT = '00000000-0000-4000-8000-0000000000e1';
    const CHAIN_PARENT = chainWord('0e');
    const child = (manages: boolean | null, onChain = true) => {
      const w = nativeWave(aWaveDoc({ parent_wave: PARENT }));
      w.store.waves.set(
        PARENT,
        aWaveRow(PARENT, {
          created_by: 'someone-else',
          admin_group_id: 'admins'
        })
      );
      if (onChain) {
        w.store.chainWaves.push(
          aChainWaveRow(CHAIN_PARENT, { origin: 'legacy', legacyId: PARENT })
        );
      }
      w.effects.manages = manages;
      return w;
    };

    // A manager on the chain: kept. The chain is asked about the parent's
    // chain id and the creator's principal, never about 6529.io's groups.
    const kept = child(true);
    await kept.run();
    expect(kept.store.waveCreates[0].entity.parent_wave_id).toBe(PARENT);
    expect(kept.effects.waveManager).toHaveBeenCalledWith({
      waveId: CHAIN_PARENT,
      principal: P1
    });

    // Not a manager: written without it, counted.
    const refused = child(false);
    const second = await refused.run();
    expect(refused.store.waveCreates[0].entity.parent_wave_id).toBeNull();
    expect(second.counter.waiting).toMatchObject({
      wave_parent_not_managed: 1
    });

    // The chain's answer unread: the wave waits, counted, and is written
    // with its parent once a run reads it.
    const unread = child(null);
    const third = await unread.run();
    expect(third.report.waves).toMatchObject({ mirrored: 0, waiting: 1 });
    expect(third.counter.waiting).toEqual({
      wave_parent_rights_unavailable: 1
    });
    expect(unread.store.waveCreates).toEqual([]);
    unread.effects.manages = true;
    await unread.run();
    expect(
      unread.store.waveCreates.map((c) => c.entity.parent_wave_id)
    ).toEqual([PARENT]);

    // A parent the chain doesn't hold (it stays on 6529.io): written without
    // it, counted, and nothing asked.
    const staying = child(true, false);
    const fourth = await staying.run();
    expect(staying.store.waveCreates[0].entity.parent_wave_id).toBeNull();
    expect(fourth.counter.waiting).toMatchObject({
      wave_parent_not_on_chain: 1
    });
    expect(staying.effects.waveManager).not.toHaveBeenCalled();

    // A parent with a parent of its own: left out, nothing asked.
    const nested = child(true);
    nested.store.waves.set(
      PARENT,
      aWaveRow(PARENT, { created_by: 'someone-else', parent_wave_id: 'grand' })
    );
    const fifth = await nested.run();
    expect(nested.store.waveCreates[0].entity.parent_wave_id).toBeNull();
    expect(fifth.counter.waiting).toMatchObject({ wave_parent_left_out: 1 });
    expect(nested.effects.waveManager).not.toHaveBeenCalled();
  });

  it('keeps a parent made on the chain that the run reaches after its child', async () => {
    // The child's id sorts first, so the run reaches it before its parent.
    const PARENT = chainWord('0c');
    const w = nativeWave(aWaveDoc({ parent_wave: PARENT }));
    // The creator is in G, so it can see the parent it names.
    w.effects.manages = true;
    w.store.chainWaves = [
      aChainWaveRow(W, { read: G, admin: G, metadataCid: CID }),
      aChainWaveRow(PARENT, { read: G, admin: G, metadataCid: CID2 })
    ];
    w.store.events.push({
      kind: 'WAVE_CREATED',
      id: PARENT,
      time: 1_764_400_000_000,
      actor: P1
    });
    w.documents.put(CID2, aWaveDoc({ name: 'The parent' }));
    const { report, counter } = await w.run();
    expect(report.waves).toMatchObject({ mirrored: 2, waiting: 0, failed: 0 });
    expect(
      w.store.waveCreates.map((create) => [
        create.entity.id,
        create.entity.parent_wave_id
      ])
    ).toEqual([
      [PARENT, null],
      [W, PARENT]
    ]);
    expect(counter.waiting.wave_parent_left_out).toBeUndefined();

    // A parent held for a retry (its document still on its way): the child
    // waits for it, run after run, and is created with it once it is.
    const held = nativeWave(aWaveDoc({ parent_wave: PARENT }));
    held.effects.manages = true;
    // Made a minute ago: within the day a child waits for its parent.
    held.store.events[0] = { ...held.store.events[0], time: NOW - 60_000 };
    held.store.chainWaves = [
      aChainWaveRow(W, { read: G, admin: G, metadataCid: CID }),
      aChainWaveRow(PARENT, { read: G, admin: G, metadataCid: CID2 })
    ];
    held.store.events.push({
      kind: 'WAVE_CREATED',
      id: PARENT,
      time: 1_764_400_000_000,
      actor: P1
    });
    const first = await held.run();
    expect(first.report.waves).toMatchObject({ mirrored: 0, waiting: 2 });
    expect(first.counter.waiting).toEqual({
      wave_parent_not_mirrored: 1,
      wave_document_missing: 1
    });
    held.at(NOW + 30_000);
    const early = await held.run();
    expect(early.report.waves).toMatchObject({ mirrored: 0, waiting: 2 });
    expect(early.counter.waiting).toEqual({
      wave_parent_not_mirrored: 1,
      wave_held_wave_document_missing: 1
    });
    expect(held.store.waveCreates).toEqual([]);
    held.documents.put(CID2, aWaveDoc({ name: 'The parent' }));
    held.at(NOW + 24 * 3_600_000);
    const second = await held.run();
    expect(second.report.waves).toMatchObject({ mirrored: 2, waiting: 0 });
    expect(
      held.store.waveCreates.map((create) => create.entity.parent_wave_id)
    ).toEqual([null, PARENT]);
  });

  it('creates a child on its own once its parent made on the chain is still not written a day after it was made', async () => {
    const PARENT = chainWord('0c');
    const w = nativeWave(aWaveDoc({ parent_wave: PARENT }));
    w.effects.manages = true;
    w.store.events[0] = { ...w.store.events[0], time: NOW - 60_000 };
    // The parent's creator has no profile: it waits, with no record.
    w.store.chainWaves = [
      aChainWaveRow(W, { read: G, admin: G, metadataCid: CID }),
      aChainWaveRow(PARENT, { read: G, admin: G, metadataCid: CID2 })
    ];
    w.store.events.push({
      kind: 'WAVE_CREATED',
      id: PARENT,
      time: NOW - 120_000,
      actor: chainWord('77')
    });
    w.documents.put(CID2, aWaveDoc({ name: 'The parent' }));
    const first = await w.run();
    expect(first.report.waves).toMatchObject({ mirrored: 0, waiting: 2 });
    expect(first.counter.waiting).toMatchObject({
      wave_parent_not_mirrored: 1,
      wave_creator_unmapped: 1
    });

    w.at(NOW - 60_000 + PARENT_WAIT_MS);
    const later = await w.run();
    expect(later.report.waves).toMatchObject({ mirrored: 1, waiting: 1 });
    expect(later.counter.waiting).toMatchObject({
      wave_parent_wait_over: 1,
      wave_creator_unmapped: 1
    });
    expect(w.store.waveCreates).toHaveLength(1);
    expect(w.store.waveCreates[0].entity).toMatchObject({
      id: W,
      parent_wave_id: null
    });
  });

  it('creates a child parentless when its parent made on the chain has a parent of its own', async () => {
    // Child, then parent, then grandparent, in the order the run reaches
    // them: 6529.io keeps a parent only if it is a top-level wave.
    const PARENT = chainWord('0c');
    const GRANDPARENT = chainWord('0d');
    const CID3 = `0x01551220${'cf'.repeat(32)}`;
    const w = nativeWave(aWaveDoc({ parent_wave: PARENT }));
    // The creator is in G, so it can see the parent it names.
    w.effects.manages = true;
    w.store.chainWaves = [
      aChainWaveRow(W, { read: G, admin: G, metadataCid: CID }),
      aChainWaveRow(PARENT, { read: G, admin: G, metadataCid: CID2 }),
      aChainWaveRow(GRANDPARENT, { read: G, admin: G, metadataCid: CID3 })
    ];
    for (const id of [PARENT, GRANDPARENT]) {
      w.store.events.push({
        kind: 'WAVE_CREATED',
        id,
        time: 1_764_400_000_000,
        actor: P1
      });
    }
    w.documents.put(CID2, aWaveDoc({ parent_wave: GRANDPARENT }));
    w.documents.put(CID3, aWaveDoc({ name: 'The grandparent' }));
    const { report } = await w.run();
    expect(report.waves).toMatchObject({ mirrored: 3, waiting: 0 });
    expect(
      Object.fromEntries(
        w.store.waveCreates.map((create) => [
          create.entity.id,
          create.entity.parent_wave_id
        ])
      )
    ).toEqual({ [GRANDPARENT]: null, [PARENT]: GRANDPARENT, [W]: null });
  });

  it('shows an empty description while moderation refuses it, and asks again after a deferral', async () => {
    const refused = nativeWave();
    refused.verdicts.push({ kind: 'refused', code: 'REJECTED' });
    const { counter } = await refused.run();
    expect(refused.store.waveCreates[0].description.parts).toEqual(
      EMPTY_DESCRIPTION
    );
    expect(counter.waiting).toMatchObject({ description_moderation: 1 });
    // The hold is kept under the description drop id, as an entry's; the
    // wave's record keeps a copy.
    expect(refused.store.descriptionHolds).toEqual(
      new Map([
        [
          waveDescriptionDropId(W),
          { reason: 'description_moderation', retryAt: null, attempts: 1 }
        ]
      ])
    );
    expect(refused.store.waveRecords.get(W)).toMatchObject({
      held: 'description_moderation',
      retryAt: null
    });
    expect((await refused.run()).report.waves.unchanged).toBe(1);

    const deferred = nativeWave();
    deferred.verdicts.push({ kind: 'deferred', code: 'LIMIT' });
    await deferred.run();
    expect(
      deferred.store.descriptionHolds.get(waveDescriptionDropId(W))
    ).toEqual({
      reason: 'description_moderation_deferred',
      retryAt: NOW + retryDelayMs(1),
      attempts: 1
    });
    expect(deferred.store.waveRecords.get(W)).toMatchObject({
      held: 'description_moderation_deferred',
      retryAt: NOW + retryDelayMs(1)
    });
    expect((await deferred.run()).report.waves.unchanged).toBe(1);
    deferred.at(NOW + retryDelayMs(1));
    const later = await deferred.run();
    expect(later.report.waves.mirrored).toBe(1);
    expect(deferred.store.descriptions).toEqual([
      {
        dropId: waveDescriptionDropId(W),
        waveId: W,
        parts: [{ content: 'What this wave is about', media: [] }],
        at: NOW + retryDelayMs(1)
      }
    ]);
    expect(deferred.store.waveRecords.get(W)).toMatchObject({
      held: null,
      retryAt: null
    });
    expect(deferred.store.descriptionHolds.size).toBe(0);
  });

  it("reads a description's hold from where it is kept, not from the wave's record", async () => {
    const { store, verdicts, gate, run, at } = nativeWave();
    verdicts.push({ kind: 'deferred', code: 'LIMIT' });
    await run();
    const dropId = waveDescriptionDropId(W);
    // The kept deferral waits longer than the record's copy says.
    store.descriptionHolds.set(dropId, {
      reason: 'description_moderation_deferred',
      retryAt: NOW + retryDelayMs(3),
      attempts: 2
    });
    at(NOW + retryDelayMs(1));
    await run();
    expect(gate.check).toHaveBeenCalledTimes(1);
    expect(store.waveRecords.get(W)).toMatchObject({
      held: 'description_moderation_deferred',
      retryAt: NOW + retryDelayMs(3),
      attempts: 2
    });
    // Due where it is kept: judged again, the third time counted.
    verdicts.push({ kind: 'deferred', code: 'LIMIT' });
    at(NOW + retryDelayMs(3));
    await run();
    expect(gate.check).toHaveBeenCalledTimes(2);
    expect(store.descriptionHolds.get(dropId)).toEqual({
      reason: 'description_moderation_deferred',
      retryAt: NOW + retryDelayMs(3) + retryDelayMs(3),
      attempts: 3
    });
  });

  it("keeps an imported wave's description hold under its own drop id, until the description changes", async () => {
    const { store, documents, verdicts, run } = world();
    const dropId = `description-of-${LEGACY_WAVE}`;
    store.waves.set(
      LEGACY_WAVE,
      aWaveRow(LEGACY_WAVE, {
        name: 'Made on the chain',
        picture: aWaveDoc().picture,
        created_by: 'profile-1',
        chat_replies_open: true,
        admin_drop_deletion_enabled: true
      })
    );
    store.drops.set(dropId, {
      authorId: 'profile-1',
      parts: [{ content: 'The imported description', media: [] }]
    });
    const replaced = aChainWaveRow(chainWord('0c'), {
      origin: 'legacy',
      legacyId: LEGACY_WAVE,
      policyVersion: 2,
      controller: P1,
      metadataCid: CID2
    });
    store.chainWaves = [replaced];
    documents.put(CID2, aWaveDoc());
    verdicts.push({ kind: 'refused', code: 'REJECTED' });
    const { counter } = await run();
    expect(counter.waiting).toMatchObject({ description_moderation: 1 });
    expect(store.descriptions).toEqual([]);
    expect(store.descriptionHolds.get(dropId)).toEqual({
      reason: 'description_moderation',
      retryAt: null,
      attempts: 1
    });
    expect((await run()).report.waves.unchanged).toBe(1);

    // A new document with another description: judged again, and written.
    const CID3 = `0x01551220${'cf'.repeat(32)}`;
    documents.put(
      CID3,
      aWaveDoc({ description: [{ content: 'Rewritten', media: [] }] })
    );
    store.chainWaves = [
      aChainWaveRow(chainWord('0c'), {
        origin: 'legacy',
        legacyId: LEGACY_WAVE,
        policyVersion: 2,
        controller: P1,
        metadataCid: CID3
      })
    ];
    expect((await run()).report.waves.mirrored).toBe(1);
    expect(store.drops.get(dropId)?.parts).toEqual([
      { content: 'Rewritten', media: [] }
    ]);
    expect(store.descriptionHolds.size).toBe(0);
    expect(store.waveRecords.get(chainWord('0c'))).toMatchObject({
      held: null
    });
  });

  it('carries the description holds the wave records kept over, once', async () => {
    const { store, run } = nativeWave();
    await run();
    const record = store.waveRecords.get(W)!;
    store.waveRecords.set(W, {
      ...record,
      held: 'description_moderation',
      retryAt: null,
      attempts: 1
    });
    store.descriptionHoldsCarried = false;
    await run();
    expect(store.descriptionHolds).toEqual(
      new Map([
        [
          waveDescriptionDropId(W),
          { reason: 'description_moderation', retryAt: null, attempts: 1 }
        ]
      ])
    );
    // Released where it is kept: not carried over again.
    store.descriptionHolds.clear();
    await run();
    expect(store.descriptionHolds.size).toBe(0);
  });

  it("writes no description hold in a rebuild: it reads the live mirror's", async () => {
    const { store, verdicts, run } = nativeWave();
    store.mode = 'rebuild';
    const kept = {
      reason: 'description_moderation',
      retryAt: null,
      attempts: 1
    };
    store.descriptionHolds.set(waveDescriptionDropId(W), kept);
    verdicts.push({ kind: 'refused', code: 'description_moderation' });
    await run();
    expect(store.waveCreates[0].description.parts).toEqual(EMPTY_DESCRIPTION);
    expect(store.descriptionHolds).toEqual(
      new Map([[waveDescriptionDropId(W), kept]])
    );
    // Its record's copy is the live mirror's.
    expect(store.waveRecords.get(W)).toMatchObject({
      held: 'description_moderation',
      retryAt: null,
      attempts: 1
    });
  });

  it('asks for a missing document again later, not every run', async () => {
    const { store, documents, run, at } = nativeWave();
    documents.docs.clear();
    const first = await run();
    expect(first.counter.waiting).toMatchObject({ wave_document_missing: 1 });
    expect(store.waveRecords.get(W)).toMatchObject({
      written: null,
      held: 'wave_document_missing',
      retryAt: NOW + retryDelayMs(1)
    });
    const asked = documents.asked.length;
    expect((await run()).report.waves.waiting).toBe(1);
    expect(documents.asked).toHaveLength(asked);
    documents.put(CID, aWaveDoc());
    at(NOW + retryDelayMs(1));
    expect((await run()).report.waves.mirrored).toBe(1);
    expect(store.waveCreates).toHaveLength(1);
  });

  it('applies a replaced policy to an imported wave: a new read group, a new controller', async () => {
    const { store, effects, documents, run } = world();
    store.importedGroups.set(LEGACY_GROUP, IMPORTED_GROUP_ID);
    store.chainGroups = [
      aChainGroupRow(G, {}, { origin: 'legacy', legacyId: LEGACY_GROUP })
    ];
    store.waves.set(
      LEGACY_WAVE,
      aWaveRow(LEGACY_WAVE, {
        name: 'Made on the chain',
        picture: aWaveDoc().picture,
        created_by: 'profile-1',
        chat_replies_open: true,
        admin_drop_deletion_enabled: true
      })
    );
    store.drops.set(`description-of-${LEGACY_WAVE}`, {
      authorId: 'profile-1',
      parts: [{ content: 'What this wave is about', media: [] }]
    });
    store.metadata.set(
      LEGACY_WAVE,
      new Map([['wave_display.rules.custom', 'Be kind']])
    );
    documents.put(CID2, aWaveDoc());
    store.chainWaves = [
      aChainWaveRow(chainWord('0c'), {
        origin: 'legacy',
        legacyId: LEGACY_WAVE,
        policyVersion: 2,
        read: G,
        controller: P2,
        metadataCid: CID2
      })
    ];
    const { report } = await run();
    expect(report.waves.mirrored).toBe(1);
    expect(store.waveEdits).toEqual([
      {
        waveId: LEGACY_WAVE,
        patch: { visibility: { scope: { group_id: IMPORTED_GROUP_ID } } },
        createdBy: 'profile-2'
      }
    ]);
    expect(store.descriptions).toEqual([]);
    expect(effects.waveChanged).toHaveBeenCalledWith({
      waveId: LEGACY_WAVE,
      groupIds: [IMPORTED_GROUP_ID],
      followerId: null
    });
    expect(store.groupRecords.get(G)).toMatchObject({
      groupId: IMPORTED_GROUP_ID,
      version: null
    });
    expect((await run()).report.waves.unchanged).toBe(1);
  });

  it("needs a wave's post group only while its chat is on", async () => {
    const { store, run } = world();
    store.importedGroups.set(LEGACY_GROUP, IMPORTED_GROUP_ID);
    store.chainGroups = [
      aChainGroupRow(G, {}, { origin: 'legacy', legacyId: LEGACY_GROUP })
    ];
    store.waves.set(
      LEGACY_WAVE,
      aWaveRow(LEGACY_WAVE, { chat_enabled: false, chat_group_id: 'own' })
    );
    // The import gave a chat-off wave a post group 6529.io has no row of.
    const wave = aChainWaveRow(chainWord('0c'), {
      origin: 'legacy',
      legacyId: LEGACY_WAVE,
      policyVersion: 2,
      read: G,
      post: chainWord('0d'),
      controller: chainWord('77')
    });
    store.chainWaves = [wave];
    await run();
    expect(store.waveEdits).toEqual([
      {
        waveId: LEGACY_WAVE,
        patch: { visibility: { scope: { group_id: IMPORTED_GROUP_ID } } },
        createdBy: null
      }
    ]);
    // Chat on: the post group is needed, and the wave waits for it.
    store.waveEdits = [];
    store.waveRecords.clear();
    store.waves.set(
      LEGACY_WAVE,
      aWaveRow(LEGACY_WAVE, { chat_enabled: true, chat_group_id: 'own' })
    );
    const { report, counter } = await run();
    expect(report.waves.waiting).toBe(1);
    expect(counter.waiting).toMatchObject({ wave_group_unknown: 1 });
    expect(store.waveEdits).toEqual([]);
  });

  it('closes an imported wave the chain closed, leaving its other fields', async () => {
    const { store, run } = world();
    store.waves.set(LEGACY_WAVE, aWaveRow(LEGACY_WAVE, { name: 'Imported' }));
    store.chainWaves = [
      aChainWaveRow(chainWord('0c'), {
        origin: 'legacy',
        legacyId: LEGACY_WAVE,
        status: 'closed',
        controller: chainWord('77')
      })
    ];
    await run();
    expect(store.waveEdits).toEqual([
      {
        waveId: LEGACY_WAVE,
        patch: { chat: { enabled: false } },
        createdBy: null
      }
    ]);
  });

  it('writes nothing in a report-only run, and counts what it would', async () => {
    const { store, effects, gate, run } = nativeWave();
    const { report, counter } = await run(false);
    expect(report.groups.mirrored).toBe(1);
    expect(report.waves.mirrored).toBe(0);
    expect(counter.waiting).toMatchObject({ wave_group_not_mirrored: 1 });
    expect(store.writes()).toBe(0);
    expect(store.transactions).toBe(0);
    expect(store.groupRecords.size).toBe(0);
    expect(gate.check).not.toHaveBeenCalled();
    expect(effects.groupsChanged).not.toHaveBeenCalled();
    expect(waveWrittenKey(chainWaveOf(store.chainWaves[0]))).toContain(CID);
  });
});

describe('WavesChainObjectsMirror: decisions made on the chain', () => {
  const D = chainWord('d1');
  const TEMPLATE_CID = `0x01551220${'cf'.repeat(32)}`;
  const NONCE = `0x${'5a'.repeat(16)}`;
  const template = {
    v: 1,
    kind: 'outcomes',
    decision: null,
    outcomes: [{ type: 'MANUAL', description: 'From the template' }],
    nonce: NONCE
  };
  const templateHash = docCommitment(
    DOC_CLASS.OUTCOME_TEMPLATE,
    `${NONCE}${'00'.repeat(16)}`,
    Buffer.from(`${JSON.stringify(template)}\n`)
  );

  /** A wave made on the chain, written, and a decision made in it. */
  function nativeDecision(
    fields: Parameters<typeof aChainDecisionRow>[2] = {}
  ) {
    const w = world();
    w.store.chainGroups = [
      aChainGroupRow(G, { includes: [{ kind: 'principal', value: P1 }] })
    ];
    w.store.groupRecords.set(G, {
      groupId: G,
      version: 1,
      includeListId: null,
      excludeListId: null,
      updatedAt: NOW
    });
    w.store.waves.set(W, aWaveRow(W));
    w.store.chainDecisions = [
      aChainDecisionRow(D, W, {
        metadataCid: CID2,
        submitGroup: G,
        config: { outcomeTemplateHash: templateHash },
        ...fields
      })
    ];
    w.store.blockTimes.set(30, 1_764_600_000_000);
    w.documents.put(CID2, aDecisionDoc({ outcome_template_cid: TEMPLATE_CID }));
    w.documents.put(TEMPLATE_CID, template);
    return w;
  }

  it("writes its competitions row once per policy version, as 6529.io's create does", async () => {
    const { store, effects, run } = nativeDecision();
    const { report, counter } = await run();
    expect(report.decisions).toMatchObject({ mirrored: 1, waiting: 0 });
    expect(store.competitionWrites).toHaveLength(1);
    const [write] = store.competitionWrites;
    expect(write.create).toBe(true);
    expect(write.record).toMatchObject({
      id: nativeCompetitionId(D),
      wave_id: W,
      legacy_wave_id: null,
      chain_id: D,
      execution_mode: 'DISABLED',
      lifecycle: 'DRAFT',
      type: 'RANK',
      title: 'Made on the chain',
      config_version: 1,
      created_at: 1_764_600_000_000,
      participation_config: { group_id: G },
      decision_config: { time_lock_ms: 3_600_000 }
    });
    // As 6529.io's draft schema reads them.
    expect(write.draft.outcomes).toEqual([
      { ...template.outcomes[0], distribution: [] }
    ]);
    expect(effects.checkCompetition).toHaveBeenCalledWith(
      write.draft,
      store.waves.get(W)
    );
    expect(store.decisionRecords.get(D)).toMatchObject({
      competitionId: nativeCompetitionId(D),
      written: 1,
      held: null
    });
    expect(counter.changes).toMatchObject({
      competitions: { insert: 1 },
      competition_config_versions: { insert: 1 }
    });

    const again = await run();
    expect(again.report.decisions).toMatchObject({ mirrored: 0, unchanged: 1 });

    // A new policy version: the row is updated, not created.
    store.chainDecisions = [
      aChainDecisionRow(D, W, {
        configVersion: 2,
        metadataCid: CID2,
        submitGroup: G,
        config: { outcomeTemplateHash: templateHash, timeLock: '7200000' }
      })
    ];
    await run();
    expect(store.competitionWrites).toHaveLength(2);
    expect(store.competitionWrites[1]).toMatchObject({
      create: false,
      record: {
        config_version: 2,
        decision_config: { time_lock_ms: 7_200_000 }
      }
    });
  });

  it('takes its creation time from the block its first policy took effect at, when the chain says', async () => {
    const { store, effects, run } = nativeDecision();
    effects.decisionCreatedAt.mockResolvedValue(1_764_550_000_000);
    await run();
    expect(effects.decisionCreatedAt).toHaveBeenCalledWith(D);
    expect(store.competitionWrites[0].record.created_at).toBe(
      1_764_550_000_000
    );
  });

  it('waits for its wave, its groups and its creditor', async () => {
    const noWave = nativeDecision();
    noWave.store.waves.clear();
    expect((await noWave.run()).counter.waiting).toMatchObject({
      decision_wave_not_mirrored: 1
    });
    const noGroup = nativeDecision();
    noGroup.store.groupRecords.clear();
    noGroup.principals.delete(P1);
    expect((await noGroup.run()).counter.waiting).toMatchObject({
      decision_group_not_mirrored: 1
    });
    const noCreditor = nativeDecision({
      config: { outcomeTemplateHash: templateHash, creditor: chainWord('99') }
    });
    expect((await noCreditor.run()).counter.waiting).toMatchObject({
      decision_creditor_unmapped: 1
    });
    for (const w of [noWave, noGroup, noCreditor]) {
      expect(w.store.competitionWrites).toEqual([]);
      expect(w.store.decisionRecords.size).toBe(0);
    }
  });

  it('holds a missing document for a retry, and a template that fails its commitment until a new version', async () => {
    const missing = nativeDecision();
    missing.documents.docs.delete(CID2);
    await missing.run();
    expect(missing.store.decisionRecords.get(D)).toMatchObject({
      written: null,
      held: 'decision_document_missing',
      heldVersion: 1,
      retryAt: NOW + retryDelayMs(1)
    });
    const early = await missing.run();
    expect(early.counter.waiting).toMatchObject({
      decision_held_decision_document_missing: 1
    });
    missing.documents.put(
      CID2,
      aDecisionDoc({ outcome_template_cid: TEMPLATE_CID })
    );
    missing.at(NOW + retryDelayMs(1));
    expect((await missing.run()).report.decisions.mirrored).toBe(1);

    const tampered = nativeDecision();
    tampered.documents.put(TEMPLATE_CID, { ...template, outcomes: [] });
    await tampered.run();
    expect(tampered.store.decisionRecords.get(D)).toMatchObject({
      held: 'decision_outcomes_commitment',
      retryAt: null
    });
    tampered.at(NOW + 7 * 24 * 3_600_000);
    expect((await tampered.run()).report.decisions.waiting).toBe(1);
    expect(tampered.store.competitionWrites).toEqual([]);
  });

  it("holds a config 6529.io's checks refuse", async () => {
    const { store, effects, run } = nativeDecision();
    effects.checkCompetition.mockRejectedValueOnce(
      new BadRequestException('Outcomes are not valid')
    );
    await run();
    expect(store.decisionRecords.get(D)).toMatchObject({
      held: 'decision_config_refused',
      retryAt: null
    });
    expect(store.competitionWrites).toEqual([]);
  });

  it('writes nothing in a report-only run, and counts what it would', async () => {
    const { store, run } = nativeDecision();
    const { report, counter } = await run(false);
    expect(report.decisions.mirrored).toBe(1);
    expect(counter.changes.competitions).toEqual({
      insert: 1,
      update: 0,
      delete: 0
    });
    expect(store.writes()).toBe(0);
    expect(store.decisionRecords.size).toBe(0);
  });
});
