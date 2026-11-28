import { PROFILE_GROUP_CHANGES, PROFILE_GROUPS_TABLE } from '@/constants';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { Logger } from '@/logging';
import { BadRequestException } from '@/exceptions';
import { ConnectionWrapper, SqlExecutor } from '@/sql-executor';
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
  emptyObjectsReport,
  GROUPS_HELD_REPORT_MS,
  IMPORTED_REMAP_CAP,
  importedListsCappedNote,
  importedRemapCapOf,
  PARENT_WAIT_MS,
  WavesChainObjectsMirror
} from './waves-chain-mirror.objects';
import { WavesChainObjectsDb } from './waves-chain-mirror.objects.db';
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
  const run = async (
    write = true,
    outOfTime = () => false,
    height: number | null = null,
    importedRemapCap?: number
  ) => {
    const counter = new PlanCounter();
    const report = await mirror.run({
      write,
      documents,
      counter,
      outOfTime,
      height,
      importedRemapCap
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

    // The next runs read the lists again against the wallets' identities:
    // the same profiles, so nothing is written and no change is logged.
    const transactions = store.transactions;
    for (let i = 0; i < 2; i++) {
      const again = await run();
      expect(again.report.groups).toMatchObject({ mirrored: 0, unchanged: 1 });
      expect(again.report.remap).toEqual(emptyObjectsReport().remap);
      expect(again.counter.changes).toEqual({});
    }
    expect(store.groupWrites).toHaveLength(1);
    expect(store.listRewrites).toEqual([]);
    expect(store.transactions).toBe(transactions);
    expect(store.groupChanges).toEqual([]);
    expect(effects.groupsChanged).toHaveBeenCalledTimes(1);
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

  it.each(['live', 'rebuild'] as const)(
    "%s: holds a group listing addresses until the identity mirror stands at the group's height, then gives a missing address its identity at the group's block time",
    async (mode) => {
      const { store, run } = world();
      store.mode = mode;
      store.identityHeight = 19;
      store.chainGroups = [
        aChainGroupRow(
          G,
          { includes: [{ kind: 'address', value: A2 }] },
          { height: 20, activeFrom: 1_764_000_123_000 }
        )
      ];
      const first = await run();
      expect(first.report.groups.waiting).toBe(1);
      expect(first.counter.waiting).toEqual({
        group_identity_rows_not_reached: 1
      });
      expect(store.addedIdentities).toEqual([]);
      expect(store.writes()).toBe(0);
      expect(store.held).toEqual({
        since: NOW,
        height: 20,
        count: 1,
        reported: false
      });

      // The identity mirror reaches the group's height: the group is
      // written, its address given an identity as of the group's write.
      store.identityHeight = 20;
      const second = await run();
      expect(second.report.groups.mirrored).toBe(1);
      expect(store.addedIdentities).toEqual([A2]);
      expect(store.identityTimes.get(A2)).toBe(1_764_000_123_000);
      expect(store.groupWrites[0].includes).toEqual([
        `profile-of-${A2.slice(2, 8)}`
      ]);
      expect(store.held).toBeNull();
    }
  );

  it('never holds a group that lists no address', async () => {
    const { store, run } = world();
    store.identityHeight = 0;
    store.chainGroups = [
      aChainGroupRow(G, { includes: [{ kind: 'principal', value: P2 }] })
    ];
    const { report, counter } = await run();
    expect(report.groups.mirrored).toBe(1);
    expect(counter.waiting).toEqual({});
    expect(store.held).toBeNull();
  });

  it('waits with a group whose listed address is left without a profile id, writing nothing', async () => {
    const { store, run } = world();
    store.chainGroups = [
      aChainGroupRow(G, { includes: [{ kind: 'address', value: A2 }] })
    ];
    // An address mapped to a row of several wallets that has no id.
    store.addAddressIdentities = async () => new Map();
    const { report, counter } = await run();
    expect(report.groups.waiting).toBe(1);
    expect(counter.waiting).toEqual({ group_address_without_profile: 1 });
    expect(store.writes()).toBe(0);
    expect(store.groupRecords.has(G)).toBe(false);
  });

  it.each([
    ['report-only', false],
    ['writing', true]
  ])(
    '%s: waits with a group listing an address an identity of several wallets without a profile id holds, counting no write',
    async (_, write) => {
      const { store, run } = world();
      store.mappedElsewhere.add(A2);
      store.chainGroups = [
        aChainGroupRow(G, {
          includes: [
            { kind: 'address', value: A1 },
            { kind: 'address', value: A2 }
          ]
        })
      ];
      const { report, counter } = await run(write);
      expect(report.groups).toMatchObject({ mirrored: 0, waiting: 1 });
      expect(counter.waiting).toEqual({ group_address_without_profile: 1 });
      expect(counter.changes).toEqual({});
      expect(store.addedIdentities).toEqual([]);
      expect(store.writes()).toBe(0);
    }
  );

  it.each(['live', 'rebuild'] as const)(
    '%s: reports a hold once it has lasted 15 minutes, naming the oldest held height, and again only after a new hold',
    async (mode) => {
      const warn = jest
        .spyOn(Logger.get('WAVES_CHAIN_MIRROR_OBJECTS'), 'warn')
        .mockImplementation(() => undefined);
      try {
        const { store, run, at } = world();
        store.mode = mode;
        store.identityHeight = 10;
        store.chainGroups = [
          aChainGroupRow(
            G,
            { includes: [{ kind: 'address', value: A1 }] },
            { height: 30 }
          ),
          aChainGroupRow(
            chainWord('0c'),
            { includes: [{ kind: 'address', value: A2 }] },
            { height: 25 }
          )
        ];
        const held = () =>
          warn.mock.calls.filter(([line]) =>
            String(line).includes('[GROUPS HELD FOR IDENTITY ROWS]')
          );
        await run();
        at(NOW + GROUPS_HELD_REPORT_MS - 1);
        await run();
        expect(held()).toEqual([]);

        at(NOW + GROUPS_HELD_REPORT_MS);
        await run();
        expect(held()).toEqual([
          [
            `[WAVES CHAIN MIRROR] [GROUPS HELD FOR IDENTITY ROWS] [OLDEST HEIGHT 25] [HELD SINCE ${new Date(
              NOW
            ).toISOString()}] [GROUPS 2]`
          ]
        ]);
        at(NOW + 2 * GROUPS_HELD_REPORT_MS);
        await run();
        expect(held()).toHaveLength(1);

        // The hold clears; a new one is reported once it lasts again.
        store.identityHeight = null;
        at(NOW + 3 * GROUPS_HELD_REPORT_MS);
        await run();
        expect(store.held).toBeNull();
        store.chainGroups = [
          aChainGroupRow(
            chainWord('0d'),
            { includes: [{ kind: 'address', value: A2 }] },
            { height: 40 }
          )
        ];
        store.identityHeight = 39;
        const start = NOW + 4 * GROUPS_HELD_REPORT_MS;
        at(start);
        await run();
        at(start + GROUPS_HELD_REPORT_MS);
        await run();
        expect(held()).toHaveLength(2);
        expect(held()[1][0]).toContain(
          `[OLDEST HEIGHT 40] [HELD SINCE ${new Date(start).toISOString()}] [GROUPS 1]`
        );
      } finally {
        warn.mockRestore();
      }
    }
  );

  it('keeps a hold through a run that left groups for later', async () => {
    const { store, run, at } = world();
    store.identityHeight = 10;
    store.chainGroups = [
      aChainGroupRow(
        G,
        { includes: [{ kind: 'address', value: A1 }] },
        { height: 30 }
      )
    ];
    await run();
    at(NOW + 60_000);
    await run(true, () => true);
    expect(store.held).toMatchObject({ since: NOW, height: 30, count: 1 });
  });

  it('keeps a hold through a run whose look at a held group failed, and clears it once a full look finds none', async () => {
    const error = jest
      .spyOn(Logger.get('WAVES_CHAIN_MIRROR_OBJECTS'), 'error')
      .mockImplementation(() => undefined);
    try {
      const { store, run, at } = world();
      store.identityHeight = 10;
      store.chainGroups = [
        aChainGroupRow(
          G,
          { includes: [{ kind: 'address', value: A1 }] },
          { height: 30 }
        )
      ];
      await run();
      at(NOW + 60_000);
      jest
        .spyOn(store, 'identityRowsReached')
        .mockRejectedValueOnce(new Error('identity state unreadable'));
      const failed = await run();
      expect(failed.report.groups.failed).toBe(1);
      expect(store.held).toMatchObject({ since: NOW, height: 30, count: 1 });

      // The identity rows catch up: a full look clears the hold.
      store.identityHeight = null;
      await run();
      expect(store.held).toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  it('clears a hold, and reports the next one, while a group listing no address fails every run', async () => {
    const log = Logger.get('WAVES_CHAIN_MIRROR_OBJECTS');
    const error = jest.spyOn(log, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const { store, run, at } = world();
      const BROKEN = chainWord('0e');
      const groupRow = store.groupRow.bind(store);
      jest.spyOn(store, 'groupRow').mockImplementation(async (id) => {
        if (id === BROKEN) throw new Error('group row unreadable');
        return groupRow(id);
      });
      store.identityHeight = 10;
      store.chainGroups = [
        aChainGroupRow(
          G,
          { includes: [{ kind: 'address', value: A1 }] },
          { height: 30 }
        ),
        aChainGroupRow(BROKEN, { includes: [{ kind: 'principal', value: P2 }] })
      ];
      const heldWarns = () =>
        warn.mock.calls.filter(([line]) =>
          String(line).includes('[GROUPS HELD FOR IDENTITY ROWS]')
        );
      await run();
      at(NOW + GROUPS_HELD_REPORT_MS);
      await run();
      expect(store.held).toMatchObject({ count: 1, reported: true });
      expect(heldWarns()).toHaveLength(1);

      // The identity rows catch up: the hold clears, the failing group
      // listing no address notwithstanding.
      store.identityHeight = null;
      at(NOW + 2 * GROUPS_HELD_REPORT_MS);
      const caughtUp = await run();
      expect(caughtUp.report.groups).toMatchObject({ mirrored: 1, failed: 1 });
      expect(store.held).toBeNull();

      // A new hold is reported once it lasts.
      store.chainGroups.push(
        aChainGroupRow(
          chainWord('0d'),
          { includes: [{ kind: 'address', value: A2 }] },
          { height: 40 }
        )
      );
      store.identityHeight = 39;
      const start = NOW + 3 * GROUPS_HELD_REPORT_MS;
      at(start);
      await run();
      at(start + GROUPS_HELD_REPORT_MS);
      await run();
      expect(heldWarns()).toHaveLength(2);
      expect(heldWarns()[1][0]).toContain(
        `[OLDEST HEIGHT 40] [HELD SINCE ${new Date(start).toISOString()}] [GROUPS 1]`
      );
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('keeps the held count and oldest height of the last full look when the budget runs out after the first held group', async () => {
    const warn = jest
      .spyOn(Logger.get('WAVES_CHAIN_MIRROR_OBJECTS'), 'warn')
      .mockImplementation(() => undefined);
    try {
      const { store, run, at } = world();
      store.identityHeight = 10;
      store.chainGroups = [
        aChainGroupRow(
          G,
          { includes: [{ kind: 'address', value: A1 }] },
          { height: 30 }
        ),
        aChainGroupRow(
          chainWord('0c'),
          { includes: [{ kind: 'address', value: A2 }] },
          { height: 25 }
        )
      ];
      await run();
      expect(store.held).toMatchObject({ since: NOW, height: 25, count: 2 });

      // Time for one group: G is looked at, still held; the other is left.
      at(NOW + GROUPS_HELD_REPORT_MS);
      let looks = 0;
      const partial = await run(true, () => ++looks > 1);
      expect(partial.report.groups).toMatchObject({ waiting: 1, left: 1 });
      expect(store.held).toEqual({
        since: NOW,
        height: 25,
        count: 2,
        reported: true
      });
      // Its WARN names the last full look's count and height.
      expect(
        warn.mock.calls.filter(([line]) =>
          String(line).includes('[GROUPS HELD FOR IDENTITY ROWS]')
        )
      ).toEqual([
        [
          `[WAVES CHAIN MIRROR] [GROUPS HELD FOR IDENTITY ROWS] [OLDEST HEIGHT 25] [HELD SINCE ${new Date(
            NOW
          ).toISOString()}] [GROUPS 2]`
        ]
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('counts a held group in a report-only run, but keeps no hold and writes no WARN', async () => {
    const warn = jest
      .spyOn(Logger.get('WAVES_CHAIN_MIRROR_OBJECTS'), 'warn')
      .mockImplementation(() => undefined);
    try {
      const { store, run, at } = world();
      store.identityHeight = 10;
      store.chainGroups = [
        aChainGroupRow(
          G,
          { includes: [{ kind: 'address', value: A1 }] },
          { height: 30 }
        )
      ];
      const first = await run(false);
      expect(first.counter.waiting).toEqual({
        group_identity_rows_not_reached: 1
      });
      at(NOW + 2 * GROUPS_HELD_REPORT_MS);
      await run(false);
      expect(store.held).toBeNull();
      expect(
        warn.mock.calls.filter(([line]) =>
          String(line).includes('[GROUPS HELD FOR IDENTITY ROWS]')
        )
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('waits with a group listing an address without an identity when its write has no block time', async () => {
    const { store, run } = world();
    const row = aChainGroupRow(G, {
      includes: [{ kind: 'address', value: A2 }]
    });
    (row.data as { activeFrom: number | null }).activeFrom = null;
    store.chainGroups = [row];
    // Its creation event dates the row; the list's ids need the write's own time.
    store.events.push({
      kind: 'GROUP_CREATED',
      id: G,
      time: 1_764_000_000_000,
      actor: P1
    });
    const { report, counter } = await run();
    expect(report.groups.waiting).toBe(1);
    expect(counter.waiting).toEqual({ group_without_block_time: 1 });
    expect(store.addedIdentities).toEqual([]);
    expect(store.writes()).toBe(0);
  });

  it("counts an address's own row without a profile id as an update, a missing row as an insert", async () => {
    const { store, run } = world();
    store.rowsWithoutProfile.add(A1);
    store.chainGroups = [
      aChainGroupRow(G, {
        includes: [
          { kind: 'address', value: A1 },
          { kind: 'address', value: A2 }
        ]
      })
    ];
    const { counter } = await run(false);
    expect(counter.changes.identities).toEqual({
      insert: 1,
      update: 1,
      delete: 0
    });
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

describe('WavesChainObjectsMirror: member lists follow wallet bindings', () => {
  const G2 = chainWord('0c');
  const INCLUDE = groupListId(G, 1, 'include');
  const EXCLUDE = groupListId(G, 1, 'exclude');
  const listed = (
    store: FakeObjectsStore,
    listId: string
  ): string[] | undefined => {
    const list = store.lists.get(listId);
    return list ? Array.from(list).sort() : undefined;
  };
  /** A group of P2 and the wallet A1, written with A1 in identity `at`. */
  const written = async (at: string) => {
    const w = world();
    w.store.addressProfiles.set(A1, at);
    w.store.chainGroups = [
      aChainGroupRow(G, {
        includes: [
          { kind: 'principal', value: P2 },
          { kind: 'address', value: A1 }
        ]
      })
    ];
    await w.run();
    expect(listed(w.store, INCLUDE)).toEqual(['profile-2', at].sort());
    return w;
  };

  it('moves a listed wallet that joins an identity to it, in place, with its change log in the same transaction', async () => {
    const { store, effects, run } = await written('profile-a1');
    // A1 joins identity Z.
    store.addressProfiles.set(A1, 'profile-z');
    const transactions = store.transactions;
    const { report, counter } = await run();
    expect(report.groups).toMatchObject({ mirrored: 0, unchanged: 1 });
    expect(store.groupWrites).toHaveLength(1);
    expect(store.listRewrites).toEqual([
      {
        lists: [
          { listId: INCLUDE, added: ['profile-z'], removed: ['profile-a1'] }
        ],
        profiles: ['profile-z', 'profile-a1'],
        inTransaction: true
      }
    ]);
    expect(store.transactions).toBe(transactions + 1);
    expect(store.groupChanges).toEqual(['profile-z', 'profile-a1']);
    expect(listed(store, INCLUDE)).toEqual(['profile-2', 'profile-z']);
    expect(store.groupRecords.get(G)).toMatchObject({
      version: 1,
      includeListId: INCLUDE
    });
    // Logged with the lists, and again by the effect after the commit.
    expect(effects.groupsChanged).toHaveBeenLastCalledWith(
      [G],
      ['profile-z', 'profile-a1']
    );
    expect(report.remap).toEqual({
      ...emptyObjectsReport().remap,
      groups: 1,
      include: { added: 1, removed: 1 }
    });
    expect(counter.changes).toEqual({
      profile_groups: { insert: 1, update: 0, delete: 1 }
    });
  });

  it('moves a listed wallet that leaves an identity to the row the identity mirror gave it, making none', async () => {
    const { store, run } = await written('profile-z');
    store.addressProfiles.set(A1, 'profile-own-a1');
    await run();
    expect(listed(store, INCLUDE)).toEqual(['profile-2', 'profile-own-a1']);
    expect(store.addedIdentities).toEqual([]);
  });

  it('waits with a group whose listed wallet resolves to no profile, keeping its lists and making no row', async () => {
    const { store, run } = await written('profile-a1');
    store.addressProfiles.delete(A1);
    const { report, counter } = await run();
    expect(counter.waiting).toEqual({
      group_remap_address_without_profile: 1
    });
    expect(report.remap).toMatchObject({ groups: 0, waiting: 1 });
    expect(store.listRewrites).toEqual([]);
    expect(store.addedIdentities).toEqual([]);
    expect(listed(store, INCLUDE)).toEqual(['profile-2', 'profile-a1']);
  });

  it('gives a wallet listed unbound, then bound, then removed the lists a rebuild gives at the same bindings', async () => {
    const live = world();
    live.store.chainGroups = [
      aChainGroupRow(G, { includes: [{ kind: 'address', value: A2 }] })
    ];
    // Unbound: the group's write gives A2 its own row.
    await live.run();
    const own = `profile-of-${A2.slice(2, 8)}`;
    expect(live.store.addedIdentities).toEqual([A2]);
    // Bound to Z, then removed: the identity mirror gives A2 its row again
    // (the id its address derives, which nothing held after the join).
    live.store.addressProfiles.set(A2, 'profile-z');
    await live.run();
    expect(listed(live.store, INCLUDE)).toEqual(['profile-z']);
    live.store.addressProfiles.set(A2, own);
    await live.run();
    expect(live.store.addedIdentities).toEqual([A2]);

    const rebuilt = world();
    rebuilt.store.mode = 'rebuild';
    rebuilt.store.chainGroups = live.store.chainGroups;
    rebuilt.store.addressProfiles.set(A2, own);
    await rebuilt.run();
    expect(rebuilt.store.addedIdentities).toEqual([]);
    expect(rebuilt.store.lists).toEqual(live.store.lists);
    expect(rebuilt.store.groupChanges).toEqual([]);
  });

  it('excludes the whole identity an excluded wallet joins', async () => {
    const { store, run } = world();
    store.addressProfiles.set(A1, 'profile-a1');
    // Everyone not excluded.
    store.chainGroups = [
      aChainGroupRow(G, {
        predicateMode: 'all_clauses',
        excludes: [{ kind: 'address', value: A1 }]
      })
    ];
    await run();
    expect(store.groups.get(G)).toMatchObject({
      profile_group_id: null,
      excluded_profile_group_id: EXCLUDE
    });
    store.addressProfiles.set(A1, 'profile-z');
    const { report } = await run();
    expect(listed(store, EXCLUDE)).toEqual(['profile-z']);
    expect(report.remap).toMatchObject({
      groups: 1,
      include: { added: 0, removed: 0 },
      exclude: { added: 1, removed: 1 }
    });
    expect(store.groupChanges).toEqual(['profile-z', 'profile-a1']);
  });

  it("keeps a profile a principal member gives when a wallet that gave it too moves away, and a principal's rows as written", async () => {
    const { store, run, principals } = world();
    // A1 is a wallet of P1's identity; A2 is a wallet on its own.
    store.addressProfiles.set(A1, 'profile-1');
    store.addressProfiles.set(A2, 'profile-a2');
    store.chainGroups = [
      aChainGroupRow(G, {
        includes: [
          { kind: 'principal', value: P1 },
          { kind: 'address', value: A1 },
          { kind: 'address', value: A2 }
        ],
        excludes: [{ kind: 'principal', value: P2 }]
      })
    ];
    await run();
    expect(listed(store, INCLUDE)).toEqual(['profile-1', 'profile-a2']);
    // A1 leaves P1's identity; A2 joins it.
    store.addressProfiles.set(A1, 'profile-own-a1');
    store.addressProfiles.set(A2, 'profile-1');
    await run();
    expect(listed(store, INCLUDE)).toEqual(['profile-1', 'profile-own-a1']);
    expect(store.listRewrites.map((r) => r.lists)).toEqual([
      [
        {
          listId: INCLUDE,
          added: ['profile-own-a1'],
          removed: ['profile-a2']
        }
      ]
    ]);
    // A list of principals alone isn't looked at.
    expect(listed(store, EXCLUDE)).toEqual(['profile-2']);

    // A principal whose profile isn't in the list as written: the group
    // waits, its rows as they are.
    principals.set(P1, 'profile-other');
    store.addressProfiles.set(A1, 'profile-z');
    const { counter } = await run();
    expect(counter.waiting).toEqual({ group_remap_principal_not_stored: 1 });
    expect(store.listRewrites).toHaveLength(1);
    expect(listed(store, INCLUDE)).toEqual(['profile-1', 'profile-own-a1']);
  });

  it("leaves a group's lists as written while its new version waits", async () => {
    const { store, run } = await written('profile-a1');
    // Version 2 lists A2 and rates by a principal 6529.io has no profile of.
    store.chainGroups = [
      aChainGroupRow(
        G,
        {
          predicateMode: 'all_clauses',
          clauses: [
            {
              metric: 'rep',
              min: 1,
              max: '9007199254740991',
              rater: chainWord('99'),
              category: null
            }
          ],
          includes: [{ kind: 'address', value: A2 }]
        },
        { version: 2 }
      )
    ];
    store.addressProfiles.set(A1, 'profile-z');
    store.addressProfiles.set(A2, 'profile-a2');
    const { report, counter } = await run();
    expect(counter.waiting).toEqual({ group_rater_unmapped: 1 });
    expect(report.remap.groups).toBe(0);
    expect(store.listRewrites).toEqual([]);
    expect(listed(store, INCLUDE)).toEqual(['profile-2', 'profile-a1']);
  });

  it('finishes in the next run the groups a run had no time for, writing none twice', async () => {
    const { store, effects, run } = world();
    store.addressProfiles.set(A1, 'profile-a1');
    store.addressProfiles.set(A2, 'profile-a2');
    store.chainGroups = [
      aChainGroupRow(G, { includes: [{ kind: 'address', value: A1 }] }),
      aChainGroupRow(G2, { includes: [{ kind: 'address', value: A2 }] })
    ];
    await run();
    store.addressProfiles.set(A1, 'profile-z');
    store.addressProfiles.set(A2, 'profile-z');
    // Time runs out once the first group's lists are written.
    const cut = await run(true, () => store.listRewrites.length > 0);
    expect(cut.report.remap).toMatchObject({ groups: 2, left: 1 });
    expect(store.listRewrites.map((r) => r.lists[0].listId)).toEqual([INCLUDE]);
    const next = await run();
    expect(next.report.remap).toMatchObject({ groups: 1, left: 0 });
    expect(store.listRewrites.map((r) => r.lists[0].listId)).toEqual([
      INCLUDE,
      groupListId(G2, 1, 'include')
    ]);
    expect(store.groupChanges).toEqual([
      'profile-z',
      'profile-a1',
      'profile-z',
      'profile-a2'
    ]);
    expect(effects.groupsChanged.mock.calls.slice(2)).toEqual([
      [[G], ['profile-z', 'profile-a1']],
      [[G2], ['profile-z', 'profile-a2']]
    ]);
    expect((await run()).report.remap.groups).toBe(0);
    expect(store.listRewrites).toHaveLength(2);
  });

  it("reads no list while the identity mirror stands below any group's height, holding nothing", async () => {
    const { store, run } = world();
    store.addressProfiles.set(A1, 'profile-a1');
    store.addressProfiles.set(A2, 'profile-a2');
    store.chainGroups = [
      aChainGroupRow(
        G,
        { includes: [{ kind: 'address', value: A1 }] },
        { height: 20 }
      ),
      aChainGroupRow(
        G2,
        { includes: [{ kind: 'address', value: A2 }] },
        { height: 30 }
      )
    ];
    await run();
    store.addressProfiles.set(A1, 'profile-z');
    // Past the first group's height, not the second's.
    store.identityHeight = 29;
    const listsRead = jest.spyOn(store, 'groupListMembers');
    const behind = await run();
    expect(behind.report.groups).toMatchObject({ unchanged: 2, waiting: 0 });
    expect(behind.report.remap).toEqual({
      ...emptyObjectsReport().remap,
      skipped: 'identity_rows_not_reached',
      waiting: 2
    });
    expect(behind.counter.waiting).toEqual({});
    expect(listsRead).not.toHaveBeenCalled();
    expect(store.listRewrites).toEqual([]);
    expect(store.held).toBeNull();

    store.identityHeight = 30;
    const caughtUp = await run();
    expect(caughtUp.report.remap).toMatchObject({ skipped: null, groups: 1 });
    expect(listed(store, INCLUDE)).toEqual(['profile-z']);
  });

  it('counts in a report-only run what a writing run then writes', async () => {
    const { store, effects, run } = await written('profile-a1');
    store.addressProfiles.set(A1, 'profile-z');
    const calls = effects.groupsChanged.mock.calls.length;
    const dry = await run(false);
    expect(dry.report.remap).toMatchObject({
      groups: 1,
      include: { added: 1, removed: 1 }
    });
    expect(dry.counter.changes).toEqual({
      profile_groups: { insert: 1, update: 0, delete: 1 }
    });
    expect(store.listRewrites).toEqual([]);
    expect(store.groupChanges).toEqual([]);
    expect(effects.groupsChanged).toHaveBeenCalledTimes(calls);
    expect(listed(store, INCLUDE)).toEqual(['profile-2', 'profile-a1']);

    const writing = await run();
    expect(writing.report.remap).toEqual(dry.report.remap);
    expect(writing.counter.changes).toEqual(dry.counter.changes);
    expect(listed(store, INCLUDE)).toEqual(['profile-2', 'profile-z']);
  });

  it('reads nothing in a run already out of time, leaving its groups for the next', async () => {
    const { store, run } = await written('profile-a1');
    store.addressProfiles.set(A1, 'profile-z');
    const reads = [
      jest.spyOn(store, 'identityRowsReached'),
      jest.spyOn(store, 'groupListMembers'),
      jest.spyOn(store, 'chainImportedGroupsListingAddresses')
    ];
    const { report } = await run(true, () => true);
    expect(report.remap).toMatchObject({ groups: 0, left: 1 });
    reads.forEach((read) => expect(read).not.toHaveBeenCalled());
    expect(store.listRewrites).toEqual([]);
  });

  it('reports once that the lists have waited 15 minutes for the identity mirror, and again only after a new wait lasts', async () => {
    const warn = jest
      .spyOn(Logger.get('WAVES_CHAIN_MIRROR_OBJECTS'), 'warn')
      .mockImplementation(() => undefined);
    try {
      const { store, run, at } = await written('profile-a1');
      const waits = () =>
        warn.mock.calls.filter(([line]) =>
          String(line).includes('[GROUP LISTS WAIT FOR IDENTITY ROWS]')
        );
      store.identityHeight = 19;
      await run();
      at(NOW + GROUPS_HELD_REPORT_MS - 1);
      await run();
      expect(waits()).toEqual([]);
      at(NOW + GROUPS_HELD_REPORT_MS);
      await run();
      at(NOW + 2 * GROUPS_HELD_REPORT_MS);
      await run();
      expect(waits()).toEqual([
        [
          `[WAVES CHAIN MIRROR] [GROUP LISTS WAIT FOR IDENTITY ROWS] [HEIGHT 20] [WAITING SINCE ${new Date(
            NOW
          ).toISOString()}] [GROUPS 1]`
        ]
      ]);
      // The identity mirror catches up, and the wait ends.
      store.identityHeight = null;
      await run();
      store.identityHeight = 19;
      const start = NOW + 3 * GROUPS_HELD_REPORT_MS;
      at(start);
      await run();
      at(start + GROUPS_HELD_REPORT_MS);
      await run();
      expect(waits()).toHaveLength(2);
      expect(waits()[1][0]).toContain(
        `[WAITING SINCE ${new Date(start).toISOString()}]`
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("doesn't count a group as failed when its caches aren't cleared after its lists are written", async () => {
    const errors = jest
      .spyOn(Logger.get('WAVES_CHAIN_MIRROR_OBJECTS'), 'error')
      .mockImplementation(() => undefined);
    try {
      const { store, effects, run } = await written('profile-a1');
      store.addressProfiles.set(A1, 'profile-z');
      effects.groupsChanged.mockRejectedValueOnce(new Error('cache down'));
      const { report } = await run();
      expect(report.remap).toMatchObject({ groups: 1, failed: 0 });
      expect(listed(store, INCLUDE)).toEqual(['profile-2', 'profile-z']);
      expect(errors.mock.calls.map(([line]) => line)).toEqual([
        `[WAVES CHAIN MIRROR] group ${G} caches not cleared after its member lists were written: Error: cache down`
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  it('reads the lists of 1,121 groups listing addresses in one batch of each kind', async () => {
    const { store, run, principals } = world();
    const groups = Array.from({ length: 1_121 }, (_, i) => {
      const id = `0x${(i + 1).toString(16).padStart(64, '0')}`;
      const address = (n: number) =>
        `0x${(i * 4 + n + 1).toString(16).padStart(40, '0')}`;
      [0, 1, 2, 3].forEach((n) =>
        store.addressProfiles.set(address(n), `profile-${i}-${n}`)
      );
      principals.set(id, `profile-p-${i}`);
      return aChainGroupRow(
        id,
        {
          includes: [
            { kind: 'principal', value: id },
            ...[0, 1, 2].map((n) => ({
              kind: 'address',
              value: address(n)
            }))
          ],
          excludes: [{ kind: 'address', value: address(3) }]
        },
        { controller: P1 }
      );
    });
    store.chainGroups = groups;
    await run();
    expect(store.groupRecords.size).toBe(1_121);
    const reads = {
      identity: jest.spyOn(store, 'identityRowsReached'),
      lists: jest.spyOn(store, 'groupListMembers'),
      addresses: jest.spyOn(store, 'profilesOfAddresses')
    };
    const { report } = await run();
    expect(report.remap).toEqual(emptyObjectsReport().remap);
    expect(reads.identity).toHaveBeenCalledTimes(1);
    expect(reads.lists).toHaveBeenCalledTimes(1);
    expect(reads.lists.mock.calls[0][0]).toHaveLength(2 * 1_121);
    expect(reads.addresses).toHaveBeenCalledTimes(1);
    expect(reads.addresses.mock.calls[0][0]).toHaveLength(4 * 1_121);
  });
});

describe("WavesChainObjectsMirror: imported groups' member lists", () => {
  const GI = chainWord('1e');
  const LIST = 'imported-include';
  const legacyOf = (n: number) =>
    `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const listed = (store: FakeObjectsStore, listId: string) =>
    Array.from(store.lists.get(listId) ?? []).sort();
  /**
   * 6529.io's imported group `id` (its row and its include list as it
   * holds them) and the chain's version 1 of it, `chainId`.
   */
  const anImported = (
    store: FakeObjectsStore,
    n: number,
    includes: readonly Record<string, string>[],
    stored: readonly string[],
    excludes: readonly Record<string, string>[] = []
  ) => {
    const id = `imported-${n}`;
    const chainId = chainWord((0x20 + n).toString(16));
    store.importedGroups.set(legacyOf(n), id);
    store.groups.set(id, {
      id,
      name: `Imported ${n}`,
      profile_group_id: `${id}-include`,
      excluded_profile_group_id: excludes.length ? `${id}-exclude` : null
    } as unknown as UserGroupEntity);
    store.lists.set(`${id}-include`, new Set(stored));
    store.chainGroups.push(
      aChainGroupRow(
        chainId,
        { includes, excludes },
        { origin: 'legacy', legacyId: legacyOf(n) }
      )
    );
    return { id, chainId, list: `${id}-include` };
  };
  /** One imported group listing P1 and A1, as 6529.io holds it. */
  const imported = (stored: readonly string[]) => {
    const w = world();
    w.store.addressProfiles.set(A1, 'profile-a1');
    w.store.importedGroups.set(LEGACY_GROUP, IMPORTED_GROUP_ID);
    w.store.groups.set(IMPORTED_GROUP_ID, {
      id: IMPORTED_GROUP_ID,
      name: 'Readers',
      profile_group_id: LIST,
      excluded_profile_group_id: null
    } as unknown as UserGroupEntity);
    w.store.lists.set(LIST, new Set(stored));
    w.store.chainGroups = [
      aChainGroupRow(
        GI,
        {
          includes: [
            { kind: 'principal', value: P1 },
            { kind: 'address', value: A1 }
          ]
        },
        { origin: 'legacy', legacyId: LEGACY_GROUP }
      )
    ];
    return w;
  };

  it("brings 6529.io's own list to the chain's members: a missing principal added, a profile no member gives removed", async () => {
    const { store, effects, run } = imported([
      'profile-a1',
      'profile-only-here'
    ]);
    const { report, counter } = await run();
    expect(store.groupRecords.get(GI)).toMatchObject({
      groupId: IMPORTED_GROUP_ID,
      version: null
    });
    expect(listed(store, LIST)).toEqual(['profile-1', 'profile-a1']);
    expect(store.listRewrites).toEqual([
      {
        lists: [
          { listId: LIST, added: ['profile-1'], removed: ['profile-only-here'] }
        ],
        profiles: ['profile-1', 'profile-only-here'],
        inTransaction: true
      }
    ]);
    expect(store.groupChanges).toEqual(['profile-1', 'profile-only-here']);
    expect(effects.groupsChanged).toHaveBeenCalledWith(
      [IMPORTED_GROUP_ID],
      ['profile-1', 'profile-only-here']
    );
    // The row is 6529.io's: only its list is written.
    expect(store.groupWrites).toEqual([]);
    expect(report.remap).toMatchObject({
      groups: 0,
      imported: {
        groups: 1,
        include: { added: 1, removed: 1 },
        exclude: { added: 0, removed: 0 },
        capped: false,
        unmatched: 0
      }
    });
    expect(counter.changes).toEqual({
      profile_groups: { insert: 1, update: 0, delete: 1 }
    });
  });

  it('leaves a group untouched since the import, whose unbound wallet still has the row 6529.io gave it before switch-on, then follows that wallet when it joins an identity', async () => {
    const { store, run } = imported(['profile-1', 'profile-a1']);
    expect((await run()).report.remap.imported.groups).toBe(0);
    expect(store.listRewrites).toEqual([]);
    store.addressProfiles.set(A1, 'profile-z');
    await run();
    expect(listed(store, LIST)).toEqual(['profile-1', 'profile-z']);
    expect(store.listRewrites.map((r) => r.lists)).toEqual([
      [{ listId: LIST, added: ['profile-z'], removed: ['profile-a1'] }]
    ]);
  });

  it('waits with an imported group whose listed wallet has no profile, making no row for it', async () => {
    const { store, run } = imported(['profile-1', 'profile-a1']);
    store.addressProfiles.delete(A1);
    const { report, counter } = await run();
    expect(counter.waiting).toEqual({
      group_remap_address_without_profile: 1
    });
    expect(report.remap).toMatchObject({ waiting: 1 });
    expect(store.addedIdentities).toEqual([]);
    expect(store.listRewrites).toEqual([]);
  });

  it("looks only at imported lists that name an address, and at no group 6529.io's rows don't match", async () => {
    const { store, run } = world();
    store.addressProfiles.set(A1, 'profile-a1');
    // An include list of principals alone, beside an exclude list naming
    // A1: only the exclude list is looked at.
    const mixed = anImported(
      store,
      1,
      [{ kind: 'principal', value: P1 }],
      ['profile-only-here'],
      [{ kind: 'address', value: A1 }]
    );
    store.lists.set(`${mixed.id}-exclude`, new Set(['profile-a1']));
    // A group of principals alone, its list drifted: not looked at.
    const principalsOnly = anImported(
      store,
      2,
      [{ kind: 'principal', value: P2 }],
      ['profile-only-here']
    );
    // A group 6529.io has no row of.
    store.chainGroups.push(
      aChainGroupRow(
        chainWord('2f'),
        { includes: [{ kind: 'address', value: A1 }] },
        { origin: 'legacy', legacyId: legacyOf(99) }
      )
    );
    const { report } = await run();
    expect(store.listRewrites).toEqual([]);
    expect(listed(store, mixed.list)).toEqual(['profile-only-here']);
    expect(listed(store, principalsOnly.list)).toEqual(['profile-only-here']);
    expect(store.groupRecords.has(principalsOnly.chainId)).toBe(false);
    expect(report.remap.imported).toMatchObject({ groups: 0, unmatched: 1 });
    // Kept unmatched: not looked for again within a day.
    const lookups = jest.spyOn(store, 'importedGroupId');
    await run();
    expect(lookups).not.toHaveBeenCalled();
  });

  it('checks an imported group the chain replaced once, as one the chain wrote, never as an imported one', async () => {
    const { store, run } = world();
    store.addressProfiles.set(A1, 'profile-a1');
    store.importedGroups.set(LEGACY_GROUP, IMPORTED_GROUP_ID);
    store.groups.set(IMPORTED_GROUP_ID, {
      id: IMPORTED_GROUP_ID,
      name: 'Readers',
      created_at: new Date(1_700_000_000_000),
      created_by: 'group-creator',
      profile_group_id: 'old-list',
      excluded_profile_group_id: null
    } as unknown as UserGroupEntity);
    store.chainGroups = [
      aChainGroupRow(
        GI,
        { includes: [{ kind: 'address', value: A1 }] },
        { version: 2, origin: 'legacy', legacyId: LEGACY_GROUP }
      )
    ];
    await run();
    store.addressProfiles.set(A1, 'profile-z');
    const { report } = await run();
    expect(report.remap).toMatchObject({
      groups: 1,
      imported: { groups: 0 }
    });
    expect(store.listRewrites.map((r) => r.lists)).toEqual([
      [
        {
          listId: groupListId(GI, 2, 'include'),
          added: ['profile-z'],
          removed: ['profile-a1']
        }
      ]
    ]);
  });

  it('writes no imported list in a run where more change than the cap, logging one ERROR, while the other groups write', async () => {
    const errors = jest
      .spyOn(Logger.get('WAVES_CHAIN_MIRROR_OBJECTS'), 'error')
      .mockImplementation(() => undefined);
    try {
      const { store, run } = world();
      store.addressProfiles.set(A1, 'profile-a1');
      store.chainGroups = [
        aChainGroupRow(G, { includes: [{ kind: 'address', value: A1 }] })
      ];
      await run();
      store.addressProfiles.set(A1, 'profile-z');
      const lists = [1, 2, 3].map(
        (n) =>
          anImported(
            store,
            n,
            [{ kind: 'address', value: A1 }],
            [`profile-only-here-${n}`]
          ).list
      );
      const capped = await run(true, () => false, null, 2);
      expect(capped.report.remap).toMatchObject({
        groups: 1,
        imported: { groups: 3, capped: true }
      });
      expect(store.listRewrites.map((r) => r.lists[0].listId)).toEqual([
        groupListId(G, 1, 'include')
      ]);
      expect(capped.counter.changes).toEqual({
        profile_groups: { insert: 1, update: 0, delete: 1 }
      });
      expect(errors.mock.calls.map(([line]) => line)).toEqual([
        "[WAVES CHAIN MIRROR] [IMPORTED GROUP LISTS OVER CAP] [GROUPS 3] [CAP 2] no imported group's lists written this run (WAVES_CHAIN_MIRROR_IMPORTED_REMAP_CAP)"
      ]);
      lists.forEach((list, i) =>
        expect(listed(store, list)).toEqual([`profile-only-here-${i + 1}`])
      );

      // A cap the count doesn't pass: all of them written.
      const raised = await run(true, () => false, null, 3);
      expect(raised.report.remap.imported).toMatchObject({
        groups: 3,
        capped: false
      });
      lists.forEach((list) =>
        expect(listed(store, list)).toEqual(['profile-z'])
      );
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  it('counts the imported lists apart in a report-only run, over the cap too, and logs them on a line of their own', async () => {
    const info = jest
      .spyOn(Logger.get('WAVES_CHAIN_MIRROR_OBJECTS'), 'info')
      .mockImplementation(() => undefined);
    const errors = jest
      .spyOn(Logger.get('WAVES_CHAIN_MIRROR_OBJECTS'), 'error')
      .mockImplementation(() => undefined);
    try {
      const { store, run } = imported(['profile-a1', 'profile-only-here']);
      const { report, counter } = await run(false, () => false, null, 0);
      const counts = {
        groups: 1,
        include: { added: 1, removed: 1 },
        exclude: { added: 0, removed: 0 },
        capped: true,
        unmatched: 0,
        pending: 0
      };
      expect(report.remap).toMatchObject({ groups: 0, imported: counts });
      expect(counter.changes).toEqual({});
      expect(store.listRewrites).toEqual([]);
      expect(info).toHaveBeenCalledWith(
        `[WAVES CHAIN MIRROR] [IMPORTED GROUP LISTS] ${JSON.stringify(counts)}`
      );
      // Over the cap in a report-only run too: the ERROR says so.
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
      errors.mockRestore();
    }
  });

  it.each([
    ['over the cap writes none of them, with the ERROR', 2, 0],
    ['at the cap writes all of them, in that run', 3, 3]
  ])(
    'writes no imported list while matching takes several runs; then the full count %s',
    async (_, cap, written) => {
      const errors = jest
        .spyOn(Logger.get('WAVES_CHAIN_MIRROR_OBJECTS'), 'error')
        .mockImplementation(() => undefined);
      const info = jest
        .spyOn(Logger.get('WAVES_CHAIN_MIRROR_OBJECTS'), 'info')
        .mockImplementation(() => undefined);
      try {
        const { store, run } = world();
        store.addressProfiles.set(A1, 'profile-z');
        const lists = [1, 2, 3].map(
          (n) =>
            anImported(
              store,
              n,
              [{ kind: 'address', value: A1 }],
              [`profile-only-here-${n}`]
            ).list
        );
        const lookups = jest.spyOn(store, 'importedGroupId');
        // Time for one more lookup a run, then for everything.
        for (const [budget, pending] of [
          [1, 2],
          [2, 1]
        ]) {
          const { report } = await run(
            true,
            () => lookups.mock.calls.length >= budget,
            null,
            cap
          );
          expect(report.remap.imported).toMatchObject({ groups: 0, pending });
          expect(store.listRewrites).toEqual([]);
        }
        expect(store.groupRecords.size).toBe(2);
        expect(info).toHaveBeenLastCalledWith(
          `[WAVES CHAIN MIRROR] [IMPORTED GROUP LISTS] ${JSON.stringify({
            groups: 0,
            include: { added: 0, removed: 0 },
            exclude: { added: 0, removed: 0 },
            capped: false,
            unmatched: 0,
            pending: 1
          })}`
        );
        expect(errors).not.toHaveBeenCalled();

        const { report } = await run(true, () => false, null, cap);
        expect(report.remap.imported).toMatchObject({
          groups: 3,
          pending: 0,
          capped: written === 0
        });
        expect(store.listRewrites).toHaveLength(written);
        expect(errors).toHaveBeenCalledTimes(written === 0 ? 1 : 0);
        expect(lists.map((list) => listed(store, list))).toEqual(
          lists.map((_, i) =>
            written ? ['profile-z'] : [`profile-only-here-${i + 1}`]
          )
        );
      } finally {
        errors.mockRestore();
        info.mockRestore();
      }
    }
  );

  it('weighs each later run against the cap once every imported group is matched', async () => {
    const errors = jest
      .spyOn(Logger.get('WAVES_CHAIN_MIRROR_OBJECTS'), 'error')
      .mockImplementation(() => undefined);
    try {
      const { store, run } = world();
      const wallets = [A1, A2, `0x${'a3'.repeat(20)}`];
      const lists = wallets.map((wallet, i) => {
        store.addressProfiles.set(wallet, `profile-${i}`);
        return anImported(
          store,
          i + 1,
          [{ kind: 'address', value: wallet }],
          [`profile-${i}`]
        ).list;
      });
      expect((await run()).report.remap.imported).toMatchObject({
        groups: 0,
        pending: 0
      });
      // Two of the wallets move: two groups change, over a cap of 1.
      store.addressProfiles.set(A1, 'profile-z');
      store.addressProfiles.set(A2, 'profile-z');
      const capped = await run(true, () => false, null, 1);
      expect(capped.report.remap.imported).toMatchObject({
        groups: 2,
        capped: true
      });
      expect(store.listRewrites).toEqual([]);
      expect(errors).toHaveBeenCalledTimes(1);
      const within = await run(true, () => false, null, 2);
      expect(within.report.remap.imported).toMatchObject({
        groups: 2,
        capped: false
      });
      expect(lists.map((list) => listed(store, list))).toEqual([
        ['profile-z'],
        ['profile-z'],
        ['profile-2']
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  it('names a run whose imported lists the cap held', () => {
    const remap = emptyObjectsReport().remap;
    expect(importedListsCappedNote(remap, 50)).toBeNull();
    remap.imported.groups = 56;
    remap.imported.capped = true;
    expect(importedListsCappedNote(remap, 50)).toBe(
      "[IMPORTED GROUP LISTS CAPPED] [GROUPS 56] [CAP 50] imported groups' member lists left as 6529.io holds them (WAVES_CHAIN_MIRROR_IMPORTED_REMAP_CAP): a mirror under a cap they fit holds them rewritten, a difference by the cap, not drift"
    );
  });

  it('looks each imported group up once in report-only runs, keeping what it found in the process', async () => {
    const { store, run } = imported(['profile-1', 'profile-a1']);
    const lookups = jest.spyOn(store, 'importedGroupId');
    await run(false);
    await run(false);
    expect(lookups).toHaveBeenCalledTimes(1);
    expect(store.groupRecords.size).toBe(0);
    // A writing run keeps the match in its records.
    await run();
    expect(store.groupRecords.get(GI)).toMatchObject({
      groupId: IMPORTED_GROUP_ID
    });
  });

  it('reads the cap from the environment', () => {
    expect(importedRemapCapOf({})).toBe(IMPORTED_REMAP_CAP);
    expect(IMPORTED_REMAP_CAP).toBe(50);
    expect(
      importedRemapCapOf({ WAVES_CHAIN_MIRROR_IMPORTED_REMAP_CAP: ' 120 ' })
    ).toBe(120);
    expect(
      importedRemapCapOf({ WAVES_CHAIN_MIRROR_IMPORTED_REMAP_CAP: '0' })
    ).toBe(0);
    for (const bad of ['', '-1', '1.5', 'many']) {
      expect(
        importedRemapCapOf({ WAVES_CHAIN_MIRROR_IMPORTED_REMAP_CAP: bad })
      ).toBe(IMPORTED_REMAP_CAP);
    }
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

  it.each(['groupsHeld', 'groupsHeldReported'] as const)(
    'writes the waves when keeping the groups hold fails (%s), and the next run keeps it',
    async (method) => {
      const log = Logger.get('WAVES_CHAIN_MIRROR_OBJECTS');
      const error = jest
        .spyOn(log, 'error')
        .mockImplementation(() => undefined);
      const warn = jest.spyOn(log, 'warn').mockImplementation(() => undefined);
      try {
        const { store, run } = nativeWave();
        store.identityHeight = 10;
        store.chainGroups.push(
          aChainGroupRow(
            chainWord('0c'),
            { includes: [{ kind: 'address', value: A1 }] },
            { height: 30 }
          )
        );
        // A hold that has lasted 15 minutes, its WARN not written yet.
        const since = NOW - GROUPS_HELD_REPORT_MS;
        store.held = { since, height: 30, count: 1, reported: false };
        jest
          .spyOn(store, method)
          .mockRejectedValueOnce(new Error('state row unavailable'));
        const { report } = await run();
        expect(report.groups).toMatchObject({
          mirrored: 1,
          waiting: 1,
          failed: 0
        });
        expect(report.waves).toMatchObject({ mirrored: 1, failed: 0 });
        expect(store.waveCreates).toHaveLength(1);
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining('state row unavailable')
        );

        await run();
        expect(store.held).toEqual({
          since,
          height: 30,
          count: 1,
          reported: true
        });
      } finally {
        error.mockRestore();
        warn.mockRestore();
      }
    }
  );

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
    // chain id and the creator's principal, at the index's read height the
    // run is given, never about 6529.io's groups.
    const kept = child(true);
    await kept.run(true, () => false, 4_200);
    expect(kept.store.waveCreates[0].entity.parent_wave_id).toBe(PARENT);
    expect(kept.effects.waveManager).toHaveBeenCalledWith({
      waveId: CHAIN_PARENT,
      principal: P1,
      height: 4_200
    });
    // A run with no index height: the client's pin.
    const unpinned = child(true);
    await unpinned.run();
    expect(unpinned.effects.waveManager).toHaveBeenCalledWith({
      waveId: CHAIN_PARENT,
      principal: P1,
      height: null
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

  it('counts the group refs that pin a group version, which 6529.io follows by id alone', async () => {
    const { store, run } = nativeWave();
    const row = store.chainWaves[0];
    store.chainWaves = [
      {
        ...row,
        data: {
          ...(row.data as Record<string, unknown>),
          readGroup: { groupId: G, version: 2 },
          postGroup: { groupId: chainWord('00'), version: 3 },
          adminGroup: { groupId: G, version: 0 }
        }
      }
    ];
    expect((await run()).report.pinnedWaveGroupRefs).toBe(1);
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

describe('WavesChainObjectsDb: member lists', () => {
  const connection = { connection: 'tx' } as ConnectionWrapper<any>;
  const storeOf = (mode: 'live' | 'rebuild') => {
    const execute = jest.fn().mockResolvedValue([]);
    const store = new WavesChainObjectsDb(
      () => ({ execute }) as unknown as SqlExecutor,
      mode
    );
    const statements = () =>
      execute.mock.calls.map(([sql, params, options]) => ({
        sql: String(sql).replace(/\s+/g, ' ').trim(),
        params,
        options
      }));
    return { store, execute, statements };
  };

  it.each(['live', 'rebuild'] as const)(
    '%s: rewrites a list in place on the connection it is given, logging the changes only live',
    async (mode) => {
      const { store, statements } = storeOf(mode);
      await store.rewriteGroupLists(
        [{ listId: 'list-1', added: ['p-new'], removed: ['p-old'] }],
        ['p-new', 'p-old'],
        connection
      );
      const sql = statements();
      expect(
        sql.every((s) => s.options?.wrappedConnection === connection)
      ).toBe(true);
      expect(sql[0]).toMatchObject({
        sql: `delete from ${PROFILE_GROUPS_TABLE} where profile_group_id = :listId and profile_id in (:profiles)`,
        params: { listId: 'list-1', profiles: ['p-old'] }
      });
      expect(sql[1]).toMatchObject({
        sql: `insert into ${PROFILE_GROUPS_TABLE} (profile_group_id, profile_id) values (:listId, :p0)`,
        params: { listId: 'list-1', p0: 'p-new' }
      });
      const log = sql.filter((s) => s.sql.includes(PROFILE_GROUP_CHANGES));
      expect(log).toHaveLength(mode === 'live' ? 1 : 0);
      if (mode === 'live') {
        expect(log[0].sql).toContain("('p-new'");
        expect(log[0].sql).toContain("('p-old'");
      }
      expect(sql).toHaveLength(mode === 'live' ? 3 : 2);
    }
  );

  it("reads each list's profiles", async () => {
    const { store, execute } = storeOf('live');
    execute.mockResolvedValueOnce([
      { profile_group_id: 'list-1', profile_id: 'a' },
      { profile_group_id: 'list-1', profile_id: 'b' },
      { profile_group_id: 'list-2', profile_id: 'a' }
    ]);
    expect(
      await store.groupListMembers(['list-1', 'list-2', 'list-3'])
    ).toEqual(
      new Map([
        ['list-1', new Set(['a', 'b'])],
        ['list-2', new Set(['a'])]
      ])
    );
  });
});
