import {
  aChainDecision,
  aChainDecisionState,
  aChainEntry,
  aCompetition,
  anEvent,
  aTargetEntry,
  aTargetState,
  chainId,
  entryManifestDoc,
  FakeMirrorIndex,
  FakeMirrorStore,
  uuid
} from '@/tests/fixtures/waves-chain-mirror.fixture';
import { EventCursorError } from '@/waves-chain-index/waves-chain-index.events';
import { StoredDocuments } from './waves-chain-mirror.docs';
import { GateVerdict } from './waves-chain-mirror.gate';
import { NativeEntryContent } from './waves-chain-mirror.native-entries';
import { PlanCounter } from './waves-chain-mirror.plan-support';
import {
  FULL_PASS_EVERY_MS,
  mirrorSettingsFromEnv,
  nextReplayFrom,
  retryDelayMs,
  WavesChainMirror,
  WavesChainMirrorSettings
} from './waves-chain-mirror.service';

const D1 = chainId('d1');
const D2 = chainId('d2');
const D3 = chainId('d3');
const C1 = uuid(1);
const C2 = uuid(2);
const NOW = 1_765_000_000_000;

const WRITE: WavesChainMirrorSettings = {
  write: true,
  frozen: true,
  keepMainStage: false,
  mainStageWaveId: null
};
const REPORT: WavesChainMirrorSettings = { ...WRITE, write: false };

function world() {
  const store = new FakeMirrorStore();
  const index = new FakeMirrorIndex();
  // Two imported decisions with a competition each, one made on the chain.
  store.chain.set(
    D1,
    aChainDecisionState(aChainDecision({ decisionId: D1, legacyId: C1 }), {
      entries: [
        aChainEntry({
          entryId: chainId('e1'),
          decisionId: D1,
          legacyId: uuid(11)
        })
      ]
    })
  );
  store.chain.set(
    D2,
    aChainDecisionState(aChainDecision({ decisionId: D2, legacyId: C2 }))
  );
  store.chain.set(
    D3,
    aChainDecisionState(
      aChainDecision({ decisionId: D3, legacyId: null, origin: 'native' })
    )
  );
  store.target.set(C1, aTargetState(aCompetition({ id: C1 })));
  store.target.set(C2, aTargetState(aCompetition({ id: C2 })));
  store.logged = () => index.events;
  return { store, index };
}

function mirror(
  store: FakeMirrorStore,
  index: FakeMirrorIndex,
  settings: WavesChainMirrorSettings = WRITE,
  clock: () => number = () => NOW
) {
  return new WavesChainMirror(store, index, () => settings, clock);
}

describe('WavesChainMirror: when it runs', () => {
  it('leaves only the Main Stage to the runtime while it keeps running it, in either mode', async () => {
    for (const settings of [WRITE, REPORT]) {
      const { store, index } = world();
      store.target.set(
        C1,
        aTargetState(aCompetition({ id: C1, capabilities: ['MAIN_STAGE'] }))
      );
      const report = await mirror(store, index, {
        ...settings,
        keepMainStage: true
      }).run({ budgetMs: 10_000 });
      expect(report.decisions).toMatchObject({
        unchanged: 1,
        skipped: { main_stage_kept: 1, no_competition: 1 }
      });
      expect(store.applied).toEqual([]);
    }
  });

  it('reads the freeze as the freeze does: the flag, or WAVES_FREEZE_AT once it has passed', () => {
    const at = Date.UTC(2026, 10, 25);
    const env = (vars: Record<string, string>) =>
      ({ WAVES_CHAIN_MIRROR_WRITE: 'true', ...vars }) as NodeJS.ProcessEnv;
    expect(mirrorSettingsFromEnv(env({}), at).frozen).toBe(false);
    expect(
      mirrorSettingsFromEnv(env({ FEATURE_WAVES_FROZEN: 'true' }), at).frozen
    ).toBe(true);
    const freezeAt = env({ WAVES_FREEZE_AT: '2026-11-25T00:00:00Z' });
    expect(mirrorSettingsFromEnv(freezeAt, at - 1).frozen).toBe(false);
    expect(mirrorSettingsFromEnv(freezeAt, at).frozen).toBe(true);
    expect(
      mirrorSettingsFromEnv(env({ WAVES_FREEZE_AT: String(at) }), at).frozen
    ).toBe(true);
    // Anything that is not a UTC time freezes at once.
    expect(
      mirrorSettingsFromEnv(env({ WAVES_FREEZE_AT: 'false' }), 0).frozen
    ).toBe(true);
    expect(
      mirrorSettingsFromEnv(
        env({
          FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE: 'true',
          MAIN_STAGE_WAVE_ID: ' w '
        }),
        at
      )
    ).toMatchObject({ write: true, keepMainStage: true, mainStageWaveId: 'w' });
  });

  it("asks the gateway for the time of a new vote's block the log has no event at", async () => {
    const { store, index } = world();
    const vote = {
      entryId: chainId('e1'),
      voter: chainId('b1'),
      value: '5',
      updatedHeight: 90
    };
    store.chain.set(D1, { ...store.chain.get(D1)!, votes: [vote] });
    const blockTime = jest.fn().mockResolvedValue(9_000);
    await new WavesChainMirror(
      store,
      index,
      () => WRITE,
      () => NOW,
      undefined,
      undefined,
      undefined,
      blockTime
    ).run({ budgetMs: 10_000 });
    expect(blockTime).toHaveBeenCalledWith(90);
  });

  it('starts writing at WAVES_FREEZE_AT with no restart, from the environment', async () => {
    const { store, index } = world();
    const at = Date.UTC(2026, 10, 25);
    const env = process.env;
    process.env = {
      ...env,
      WAVES_CHAIN_MIRROR_WRITE: 'true',
      FEATURE_WAVES_FROZEN: undefined,
      WAVES_FREEZE_AT: '2026-11-25T00:00:00Z'
    };
    try {
      const before = await new WavesChainMirror(
        store,
        index,
        undefined,
        () => at - 1
      ).run({
        budgetMs: 10_000
      });
      expect(before).toMatchObject({ mode: 'skipped', skipped: 'not_frozen' });
      const after = await new WavesChainMirror(
        store,
        index,
        undefined,
        () => at
      ).run({
        budgetMs: 10_000
      });
      expect(after.mode).toBe('write');
    } finally {
      process.env = env;
    }
  });

  it('writes only with the waves freeze on; reports without it', async () => {
    const { store, index } = world();
    const write = await mirror(store, index, { ...WRITE, frozen: false }).run({
      budgetMs: 10_000
    });
    expect(write).toMatchObject({ mode: 'skipped', skipped: 'not_frozen' });
    const report = await mirror(store, index, { ...REPORT, frozen: false }).run(
      { budgetMs: 10_000 }
    );
    expect(report.mode).toBe('report');
  });

  it("waits for the index's first full read and the principal map", async () => {
    const { store, index } = world();
    index.state = { ...index.state, lastFullAt: null };
    expect(await mirror(store, index).run({ budgetMs: 10_000 })).toMatchObject({
      skipped: 'index_not_ready'
    });
    index.state = { ...index.state, lastFullAt: 1 };
    store.principalMap = false;
    expect(await mirror(store, index).run({ budgetMs: 10_000 })).toMatchObject({
      skipped: 'no_principal_map'
    });
  });

  it('mirrors groups and waves before decisions, only once the index read in full, in either mode', async () => {
    for (const settings of [WRITE, REPORT]) {
      const { store, index } = world();
      const order: string[] = [];
      const objects = {
        run: jest.fn(
          async (input: { write: boolean; counter: PlanCounter }) => {
            order.push(`objects:${input.write}`);
            input.counter.change('waves', 'insert');
            input.counter.wait('wave_group_not_mirrored');
            return {
              groups: {
                mirrored: 1,
                unchanged: 0,
                waiting: 0,
                failed: 0,
                left: 0
              },
              waves: {
                mirrored: 0,
                unchanged: 0,
                waiting: 1,
                failed: 0,
                left: 0
              },
              decisions: {
                mirrored: 0,
                unchanged: 0,
                waiting: 0,
                failed: 0,
                left: 0
              }
            };
          }
        )
      };
      const read = store.chainDecision.bind(store);
      store.chainDecision = async (id: string) => {
        order.push('decision');
        return read(id);
      };
      const make = () =>
        new WavesChainMirror(
          store,
          index,
          () => settings,
          () => NOW,
          undefined,
          undefined,
          undefined,
          undefined,
          objects
        );
      index.state = { ...index.state, lastFullAt: null };
      expect((await make().run({ budgetMs: 10_000 })).skipped).toBe(
        'index_not_ready'
      );
      expect(objects.run).not.toHaveBeenCalled();
      index.state = { ...index.state, lastFullAt: 1 };
      const report = await make().run({ budgetMs: 10_000 });
      expect(order[0]).toBe(`objects:${settings.write}`);
      expect(order).toContain('decision');
      expect(report.objects).toMatchObject({
        groups: { mirrored: 1 },
        waves: { waiting: 1 }
      });
      expect(report.changes.waves).toEqual({ insert: 1, update: 0, delete: 0 });
      expect(report.waiting).toMatchObject({ wave_group_not_mirrored: 1 });
    }
  });

  it('goes on to the decisions when the groups and waves pass fails', async () => {
    const { store, index } = world();
    const report = await new WavesChainMirror(
      store,
      index,
      () => WRITE,
      () => NOW,
      undefined,
      undefined,
      undefined,
      undefined,
      { run: jest.fn().mockRejectedValue(new Error('boom')) }
    ).run({ budgetMs: 10_000 });
    expect(report.objects).toBeNull();
    expect(
      report.decisions.mirrored + report.decisions.unchanged
    ).toBeGreaterThan(0);
  });
});

describe('WavesChainMirror: legacy ids', () => {
  it("leaves out a decision or an entry whose legacy id isn't an RFC 4122 UUID, counted once, and goes on", async () => {
    const { store, index } = world();
    // A made-up id with a version digit of 0: uuid v5 refuses it.
    const bad = '00000000-5662-01f5-4000-8000000001f5';
    store.chain.set(
      D2,
      aChainDecisionState(aChainDecision({ decisionId: D2, legacyId: bad }))
    );
    store.chain.set(
      D1,
      aChainDecisionState(aChainDecision({ decisionId: D1, legacyId: C1 }), {
        entries: [
          aChainEntry({
            entryId: chainId('e1'),
            decisionId: D1,
            legacyId: uuid(11)
          }),
          aChainEntry({ entryId: chainId('e2'), decisionId: D1, legacyId: bad })
        ]
      })
    );
    const m = mirror(store, index, REPORT);
    const report = await m.run({ budgetMs: 10_000 });
    expect(report.decisions).toMatchObject({
      skipped: { legacy_id_invalid: 1 },
      failed: 0
    });
    expect(report.invalidLegacyIds).toBe(2);
    // The entry left out is not waited for as one without a row.
    expect(report.waiting).toEqual({ entry_without_row: 1 });
    // Counted once each, run after run.
    expect((await m.run({ budgetMs: 10_000 })).invalidLegacyIds).toBe(2);
  });
});

describe('WavesChainMirror: report only', () => {
  it('plans every decision and writes nothing, not even its state', async () => {
    const { store, index } = world();
    store.target.delete(C2);
    const report = await mirror(store, index, REPORT).run({ budgetMs: 10_000 });
    expect(report).toMatchObject({
      mode: 'report',
      height: 100,
      network: 'net-1',
      full: { completed: true, started: 'report' },
      decisions: {
        unchanged: 1,
        skipped: { no_competition: 2 },
        failed: 0
      },
      // The entry 6529.io has no row of waits.
      waiting: { entry_without_row: 1 }
    });
    expect(store.transactions).toBe(0);
    expect(store.applied).toEqual([]);
    expect(store.savedStates).toEqual([]);
    expect(store.reportPlace).toBeNull();
    expect(index.reads).toEqual([]);
  });

  it('keeps its place when the budget runs out, and goes on from it', async () => {
    const { store, index } = world();
    // The budget runs out once the first decision is planned.
    let t = NOW;
    const read = store.chainDecision.bind(store);
    store.chainDecision = async (id: string) => {
      t += 60_000;
      return read(id);
    };
    const first = await mirror(store, index, REPORT, () => t).run({
      budgetMs: 10_000
    });
    store.chainDecision = read;
    expect(first.full).toMatchObject({ completed: false });
    expect(first.decisions.left).toBeGreaterThan(0);
    const place = store.reportPlace;
    expect(place).not.toBeNull();

    const second = await mirror(store, index, REPORT).run({ budgetMs: 10_000 });
    expect(second.full).toMatchObject({ completed: true });
    // It went on after its place: each decision was planned once in all.
    const planned = (r: typeof first) =>
      r.decisions.mirrored +
      r.decisions.unchanged +
      r.decisions.failed +
      Object.values(r.decisions.skipped).reduce((x, y) => x + y, 0);
    expect(planned(first)).toBeGreaterThan(0);
    expect(planned(first) + planned(second)).toBe(3);
    expect(store.reportPlace).toBeNull();
    expect(store.transactions).toBe(0);
    expect(store.applied).toEqual([]);
  });
});

describe('WavesChainMirror: writing', () => {
  it('starts with a full pass and moves its cursor to the end of the log', async () => {
    const { store, index } = world();
    index.events = [
      anEvent(50, 0, { decisionId: D1 }),
      anEvent(60, 0, { decisionId: D2 })
    ];
    const report = await mirror(store, index).run({ budgetMs: 10_000 });
    expect(report).toMatchObject({
      mode: 'write',
      events: 2,
      cursor: '60:0@net-1',
      full: { started: 'first', completed: true, running: false },
      decisions: {
        unchanged: 2,
        skipped: { no_competition: 1 },
        failed: 0,
        left: 0
      }
    });
    // Each decision once, each in its own transaction (the one made on
    // the chain finds no competition row yet).
    expect(store.transactions).toBe(3);
    expect(store.state).toMatchObject({
      network: 'net-1',
      eventsCursor: '60:0@net-1',
      indexGeneration: 1,
      indexHeight: 100,
      fullRunning: false,
      fullAfter: null,
      lastFullAt: NOW,
      lastError: null
    });
  });

  it('then mirrors what the log names, what is live and what the index read again', async () => {
    const { store, index } = world();
    store.state = {
      ...store.state,
      network: 'net-1',
      eventsCursor: '60:0@net-1',
      indexGeneration: 1,
      indexHeight: 100,
      lastFullAt: NOW - 1000
    };
    index.state = { ...index.state, feedNext: 121 };
    index.events = [
      anEvent(60, 0, { decisionId: D1 }),
      anEvent(110, 0, { decisionId: D1 }),
      anEvent(110, 1, { kind: 'GROUP_CREATED' })
    ];
    const asked: number[] = [];
    store.changedAbove = (height) => {
      asked.push(height);
      return [D3];
    };
    store.live = [D2];
    const report = await mirror(store, index).run({ budgetMs: 10_000 });
    expect(asked).toEqual([100]);
    expect(report).toMatchObject({
      events: 2,
      full: { started: null, running: false },
      decisions: { unchanged: 2, skipped: { no_competition: 1 } }
    });
    expect(store.state).toMatchObject({
      eventsCursor: '110:1@net-1',
      indexHeight: 120,
      lastFullAt: NOW - 1000
    });
  });

  it('starts a full pass after a GAP, every hour, and after a new full read of the index', async () => {
    const cases: [string, (s: FakeMirrorStore, i: FakeMirrorIndex) => void][] =
      [
        ['gap', (_s, i) => i.events.push(anEvent(70, 0, { kind: 'GAP' }))],
        [
          'hourly',
          (s) =>
            (s.state = { ...s.state, lastFullAt: NOW - FULL_PASS_EVERY_MS })
        ],
        [
          'index_full_read',
          (_s, i) => (i.state = { ...i.state, generation: 2 })
        ]
      ];
    for (const [reason, change] of cases) {
      const { store, index } = world();
      store.state = {
        ...store.state,
        network: 'net-1',
        eventsCursor: '60:0@net-1',
        indexGeneration: 1,
        indexHeight: 100,
        lastFullAt: NOW - 1000
      };
      change(store, index);
      const report = await mirror(store, index).run({ budgetMs: 10_000 });
      expect(report.full).toMatchObject({ started: reason, completed: true });
      expect(store.transactions).toBe(3);
    }
  });

  it('starts again on a relaunched chain, and reads the log from its start after a cursor of another network', async () => {
    const { store, index } = world();
    store.state = {
      ...store.state,
      network: 'old-net',
      eventsCursor: '900:3@old-net',
      indexGeneration: 1,
      indexHeight: 900,
      lastFullAt: NOW - 1000
    };
    index.events = [anEvent(50, 0, { decisionId: D1 })];
    const report = await mirror(store, index).run({ budgetMs: 10_000 });
    expect(report.full.started).toBe('network');
    // The old network's results go, and its entries made on the chain.
    expect(store.removedNetworks).toEqual(['chain:net-1:']);
    expect(store.releasedChainMade).toBe(1);
    expect(index.reads[0]).toBeNull();
    expect(store.state).toMatchObject({
      network: 'net-1',
      eventsCursor: '50:0@net-1'
    });

    const throwing = new FakeMirrorIndex();
    throwing.readEvents = jest
      .fn()
      .mockRejectedValue(new EventCursorError('another network'));
    store.state = { ...store.state, lastFullAt: NOW - 1000 };
    const again = await mirror(store, throwing).run({ budgetMs: 10_000 });
    expect(again.full.started).toBe('cursor');
    expect(store.state.eventsCursor).toBeNull();
  });

  it('resumes a full pass where the budget ran out, and keeps its cursor until the log is done', async () => {
    const { store, index } = world();
    index.events = [anEvent(50, 0, { decisionId: D2 })];
    let t = NOW;
    // Each read of the clock takes a second: the run has time for a few.
    const clock = () => (t += 1000);
    const first = await mirror(store, index, WRITE, clock).run({
      budgetMs: 6_500
    });
    expect(first.full).toMatchObject({ running: true, completed: false });
    expect(store.state.fullRunning).toBe(true);
    const after = store.state.fullAfter;
    expect(after).not.toBeNull();

    t = NOW;
    const second = await mirror(store, index, WRITE, () => (t += 1)).run({
      budgetMs: 10_000
    });
    expect(second.full).toMatchObject({ completed: true, running: false });
    expect(store.state).toMatchObject({ fullRunning: false, fullAfter: null });
  });

  it('leaves the cursor where it was when a decision the log names was not reached', async () => {
    const { store, index } = world();
    store.state = {
      ...store.state,
      network: 'net-1',
      eventsCursor: '60:0@net-1',
      indexGeneration: 1,
      indexHeight: 100,
      lastFullAt: NOW - 1000
    };
    index.events = [
      anEvent(70, 0, { decisionId: D1 }),
      anEvent(71, 0, { decisionId: D2 })
    ];
    let t = NOW;
    const report = await mirror(store, index, WRITE, () => (t += 1000)).run({
      budgetMs: 4_000
    });
    expect(report.decisions.left).toBeGreaterThan(0);
    expect(store.state).toMatchObject({
      eventsCursor: '60:0@net-1',
      indexHeight: 100
    });
  });

  it('retries a deadlock, and tries a decision that failed again next run, first', async () => {
    const { store, index } = world();
    store.state = {
      ...store.state,
      network: 'net-1',
      eventsCursor: null,
      indexGeneration: 1,
      indexHeight: 100,
      lastFullAt: NOW - 1000
    };
    index.events = [anEvent(70, 0, { decisionId: D1 })];
    store.failures = [{ code: 'ER_LOCK_DEADLOCK', errno: 1213 }];
    const retried = await mirror(store, index).run({ budgetMs: 10_000 });
    expect(retried.decisions).toMatchObject({ unchanged: 1, failed: 0 });
    expect(store.transactions).toBe(2);

    store.state = { ...store.state, eventsCursor: null };
    store.broken.add(D1);
    const failed = await mirror(store, index).run({ budgetMs: 10_000 });
    expect(failed.decisions.failed).toBe(1);
    expect(failed.full.started).toBeNull();
    // The cursor moves on; the decision is kept to try again, and to read
    // its events again from before its first.
    expect(store.state).toMatchObject({
      eventsCursor: '70:0@net-1',
      indexHeight: 100,
      retryIds: [D1],
      replayFrom: { [D1]: null },
      lastError: '1 decision(s) failed; see the log'
    });

    // Next run it goes through, and reads nothing again after.
    store.broken.delete(D1);
    const before = store.transactions;
    const again = await mirror(store, index).run({ budgetMs: 10_000 });
    expect(again.decisions).toMatchObject({ unchanged: 1, failed: 0 });
    expect(store.transactions).toBe(before + 1);
    expect(store.replayReads).toEqual([{ decisionId: D1, after: null }]);
    expect(store.state).toMatchObject({
      eventsCursor: '70:0@net-1',
      retryIds: [],
      replayFrom: {},
      lastError: null
    });
  });

  it("writes a failed decision's vote history when it goes through later", async () => {
    const { store, index } = world();
    store.state = {
      ...store.state,
      network: 'net-1',
      eventsCursor: '60:0@net-1',
      indexGeneration: 1,
      indexHeight: 100,
      lastFullAt: NOW - 1000
    };
    store.profiles.set(chainId('b1'), 'p1');
    store.target.set(
      C1,
      aTargetState(aCompetition({ id: C1 }), {
        entries: [aTargetEntry({ id: uuid(21), dropId: uuid(11) })]
      })
    );
    index.events = [
      anEvent(70, 0, { decisionId: D2 }),
      anEvent(71, 0, {
        kind: 'VOTE',
        decisionId: D1,
        entryId: chainId('e1'),
        actor: chainId('b1'),
        data: { oldValue: '0', newValue: '10', entryTotalAfter: '10' }
      }),
      anEvent(72, 0, { decisionId: D2 })
    ];
    const history = () => store.applied.flatMap((a) => a.writes.history);
    store.broken.add(D1);
    const failed = await mirror(store, index).run({ budgetMs: 10_000 });
    expect(failed.decisions.failed).toBe(1);
    expect(history()).toEqual([]);
    // The cursor moves on; D1 reads its events again from before its own.
    expect(store.state.eventsCursor).toBe('72:0@net-1');
    expect(store.state.replayFrom).toEqual({ [D1]: '70:0@net-1' });

    store.broken.delete(D1);
    await mirror(store, index, WRITE, () => NOW + 60_000).run({
      budgetMs: 10_000
    });
    expect(history()).toHaveLength(1);
    expect(history()[0]).toMatchObject({ height: 71, seq: 0 });
    expect(store.state).toMatchObject({
      eventsCursor: '72:0@net-1',
      retryIds: [],
      replayFrom: {}
    });
  });

  it("doesn't hold other decisions' history while one keeps failing, past more events than a run reads", async () => {
    const { store, index } = world();
    store.state = {
      ...store.state,
      network: 'net-1',
      eventsCursor: '60:0@net-1',
      indexGeneration: 1,
      indexHeight: 100,
      lastFullAt: NOW - 1000
    };
    index.state = { ...index.state, feedNext: 30_000 };
    store.profiles.set(chainId('b1'), 'p1');
    const E2 = chainId('e2');
    store.chain.set(
      D2,
      aChainDecisionState(aChainDecision({ decisionId: D2, legacyId: C2 }), {
        entries: [
          aChainEntry({ entryId: E2, decisionId: D2, legacyId: uuid(12) })
        ]
      })
    );
    store.target.set(
      C1,
      aTargetState(aCompetition({ id: C1 }), {
        entries: [aTargetEntry({ id: uuid(21), dropId: uuid(11) })]
      })
    );
    store.target.set(
      C2,
      aTargetState(aCompetition({ id: C2 }), {
        entries: [aTargetEntry({ id: uuid(22), dropId: uuid(12) })]
      })
    );
    const vote = (height: number, decisionId: string, entryId: string) =>
      anEvent(height, 0, {
        kind: 'VOTE',
        decisionId,
        entryId,
        actor: chainId('b1'),
        data: { oldValue: '0', newValue: '10', entryTotalAfter: '10' }
      });
    // D1's vote, then more events than a run reads (20 pages of 1,000),
    // then D2's.
    index.events = [
      vote(70, D1, chainId('e1')),
      ...Array.from({ length: 20_500 }, (_, i) =>
        anEvent(100 + i, 0, { kind: 'GROUP_CREATED' })
      ),
      vote(25_000, D2, E2)
    ];
    const history = (competitionId: string) =>
      store.applied
        .filter((a) => a.competitionId === competitionId)
        .flatMap((a) => a.writes.history);
    store.broken.add(D1);

    const first = await mirror(store, index).run({ budgetMs: 10_000 });
    expect(first).toMatchObject({ events: 20_000, decisions: { failed: 1 } });
    expect(store.state).toMatchObject({
      eventsCursor: '20098:0@net-1',
      retryIds: [D1],
      replayFrom: { [D1]: '60:0@net-1' }
    });

    // D1 still fails; the cursor goes on to D2's vote, and its history.
    const second = await mirror(store, index).run({ budgetMs: 10_000 });
    expect(second).toMatchObject({ events: 502, decisions: { failed: 1 } });
    expect(history(C2)).toEqual([
      expect.objectContaining({ height: 25_000, seq: 0 })
    ]);
    expect(store.state).toMatchObject({
      eventsCursor: '25000:0@net-1',
      retryIds: [D1],
      replayFrom: { [D1]: '60:0@net-1' }
    });

    // D1 goes through: its vote, read again from the log, has its history.
    store.broken.delete(D1);
    const third = await mirror(store, index).run({ budgetMs: 10_000 });
    expect(third).toMatchObject({ events: 0, decisions: { failed: 0 } });
    expect(history(C1)).toEqual([
      expect.objectContaining({ height: 70, seq: 0 })
    ]);
    expect(history(C2)).toHaveLength(1);
    expect(store.state).toMatchObject({
      eventsCursor: '25000:0@net-1',
      retryIds: [],
      replayFrom: {}
    });
  });

  it("reads a long run of a failed decision's events again over more than one run, in order, each once", async () => {
    const { store, index } = world();
    store.state = {
      ...store.state,
      network: 'net-1',
      eventsCursor: '60:0@net-1',
      indexGeneration: 1,
      indexHeight: 100,
      lastFullAt: NOW - 1000
    };
    index.state = { ...index.state, feedNext: 10_000 };
    store.profiles.set(chainId('b1'), 'p1');
    store.target.set(
      C1,
      aTargetState(aCompetition({ id: C1 }), {
        entries: [aTargetEntry({ id: uuid(21), dropId: uuid(11) })]
      })
    );
    const vote = (height: number, value: number) =>
      anEvent(height, 0, {
        kind: 'VOTE',
        decisionId: D1,
        entryId: chainId('e1'),
        actor: chainId('b1'),
        data: {
          oldValue: String(value - 1),
          newValue: String(value),
          entryTotalAfter: String(value)
        }
      });
    // More of D1's votes than one run reads again (5,000).
    index.events = [
      ...Array.from({ length: 5_002 }, (_, i) => vote(70 + i, i + 1)),
      vote(6_000, 5_003)
    ];
    const heights = () =>
      store.applied.flatMap((a) => a.writes.history.map((h) => h.height));
    store.broken.add(D1);
    await mirror(store, index).run({ budgetMs: 10_000 });
    expect(store.state).toMatchObject({
      eventsCursor: '6000:0@net-1',
      replayFrom: { [D1]: '60:0@net-1' }
    });

    store.broken.delete(D1);
    index.events.push(vote(7_000, 5_004));
    await mirror(store, index).run({ budgetMs: 10_000 });
    // The first 5,000 again; this run's vote waits for the rest.
    expect(heights()).toHaveLength(5_000);
    expect(heights().at(-1)).toBe(5_069);
    expect(store.state).toMatchObject({
      eventsCursor: '7000:0@net-1',
      retryIds: [D1],
      replayFrom: { [D1]: '5069:0@net-1' }
    });

    await mirror(store, index).run({ budgetMs: 10_000 });
    expect(heights()).toEqual([
      ...Array.from({ length: 5_002 }, (_, i) => 70 + i),
      6_000,
      7_000
    ]);
    expect(store.state).toMatchObject({ retryIds: [], replayFrom: {} });
  });
});

describe('nextReplayFrom', () => {
  it('keeps where each failed decision reads again from, and drops one that went through', () => {
    const from = new Map<string, string | null>([
      ['d-a', null],
      ['d-b', '5:0@n'],
      ['d-c', '7:0@n']
    ]);
    const before = new Map<string, string | null>([
      ['d-a', '8:0@n'],
      ['d-d', '9:0@n'],
      ['d-e', '9:5@n']
    ]);
    expect(
      Object.fromEntries(
        nextReplayFrom(
          from,
          before,
          // d-a and d-d failed; d-b went through; d-c wasn't reached.
          new Set(['d-a', 'd-d']),
          new Set(['d-a', 'd-b', 'd-d', 'd-e', 'd-f']),
          // d-f's replay stopped short.
          new Map([['d-f', '11:0@n']])
        )
      )
    ).toEqual({
      'd-a': null,
      'd-c': '7:0@n',
      'd-d': '9:0@n',
      'd-f': '11:0@n'
    });
  });
});

describe('WavesChainMirror: entries made on the chain', () => {
  const EN = chainId('e9');
  const AUTHOR = chainId('a9');
  const WAVE = uuid(900);
  const doc = entryManifestDoc({
    nonce: `0x${'5a'.repeat(16)}`,
    decision: D1,
    wave: chainId('a0'),
    author: AUTHOR,
    createdAt: 1,
    fields: { wave_id: WAVE, parts: [{ content: 'a work', media: [] }] }
  });
  const other = entryManifestDoc({
    nonce: `0x${'6b'.repeat(16)}`,
    decision: D1,
    wave: chainId('a0'),
    author: AUTHOR,
    createdAt: 1,
    fields: { wave_id: WAVE, parts: [{ content: 'another', media: [] }] }
  });

  function nativeWorld() {
    const { store, index } = world();
    store.chain.set(
      D1,
      aChainDecisionState(aChainDecision({ decisionId: D1, legacyId: C1 }), {
        entries: [
          aChainEntry({
            entryId: EN,
            decisionId: D1,
            legacyId: null,
            origin: 'native',
            author: AUTHOR,
            data: {
              manifestHash: doc.manifestHash,
              contentCid: doc.contentCid,
              createdMs: 5
            }
          })
        ]
      })
    );
    store.profiles.set(AUTHOR, 'author');
    const gateway = {
      getDocument: jest.fn().mockResolvedValue(Buffer.from(doc.bytes))
    };
    const gate = {
      check: jest.fn().mockResolvedValue({ kind: 'allowed' } as GateVerdict)
    };
    const checker = {
      check: jest.fn(async (input: { content: NativeEntryContent }) => ({
        ok: true as const,
        content: input.content
      }))
    };
    const make = (settings: WavesChainMirrorSettings, now = NOW) =>
      new WavesChainMirror(
        store,
        index,
        () => settings,
        () => now,
        (keep) => new StoredDocuments(store, gateway, keep),
        gate,
        checker
      );
    return { store, index, gateway, gate, checker, make };
  }

  it('reports one without moderating it or keeping its manifest', async () => {
    const { store, gate, make } = nativeWorld();
    const report = await make(REPORT).run({ budgetMs: 10_000 });
    expect(report.changes).toMatchObject({
      drops: { insert: 1 },
      competition_entries: { insert: 1 }
    });
    expect(gate.check).not.toHaveBeenCalled();
    expect(store.docs.size).toBe(0);
  });

  it('writes one moderation lets through, keeping its manifest', async () => {
    const { store, gate, make } = nativeWorld();
    const report = await make(WRITE).run({ budgetMs: 10_000 });
    expect(report.changes.drops).toEqual({ insert: 1, update: 0, delete: 0 });
    expect(gate.check).toHaveBeenCalledWith(
      expect.objectContaining({
        dropId: EN,
        authorProfileId: 'author',
        waveId: WAVE
      })
    );
    expect(store.docs.get(doc.contentCid)).toEqual(doc.bytes);
    expect(store.applied[0].writes.nativeEntries).toHaveLength(1);
  });

  it('holds one the collaboration write would refuse, and the decision still goes through', async () => {
    const { store, checker, gate } = nativeWorld();
    // Collaborators on an entry that isn't an artwork (no memeName).
    checker.check.mockImplementation(async (input) => ({
      ok: true as const,
      content: { ...input.content, collaboratorIds: ['collab-1'] }
    }));
    const collaborations = {
      isMainStage: jest.fn().mockResolvedValue(true),
      profiles: jest.fn().mockResolvedValue([])
    };
    const gateway = {
      getDocument: jest.fn().mockResolvedValue(Buffer.from(doc.bytes))
    };
    const report = await new WavesChainMirror(
      store,
      new FakeMirrorIndex(),
      () => WRITE,
      () => NOW,
      (keep) => new StoredDocuments(store, gateway, keep),
      gate,
      checker,
      undefined,
      null,
      collaborations
    ).run({ budgetMs: 10_000 });
    expect(report.decisions.failed).toBe(0);
    expect(report.waiting).toMatchObject({
      native_entry_held_collaboration_not_artwork: 1
    });
    expect(store.held.get(EN)).toEqual({
      reason: 'collaboration_not_artwork',
      retryAt: null,
      attempts: 1
    });
    expect(gate.check).not.toHaveBeenCalled();
    // D1 (the entry's decision) is planned, not failed.
    expect(
      report.decisions.unchanged + report.decisions.mirrored
    ).toBeGreaterThan(0);
    expect(store.applied.flatMap((a) => a.writes.nativeEntries)).toEqual([]);
  });

  it('holds one moderation refuses, and does not judge it again', async () => {
    const { store, gate, make } = nativeWorld();
    gate.check.mockResolvedValue({
      kind: 'refused',
      code: 'CONTENT_MODERATION_REJECTED'
    });
    const first = await make(WRITE).run({ budgetMs: 10_000 });
    expect(first.waiting).toMatchObject({ native_entry_held_moderation: 1 });
    expect(store.held.get(EN)).toEqual({
      reason: 'moderation',
      retryAt: null,
      attempts: 1
    });
    store.state = { ...store.state, lastFullAt: 1 };
    const again = await make(WRITE).run({ budgetMs: 10_000 });
    expect(again.waiting).toMatchObject({ native_entry_held_moderation: 1 });
    expect(gate.check).toHaveBeenCalledTimes(1);
  });

  it('waits for a manifest the store does not have, asking again later, not every run', async () => {
    const { store, gateway, gate, make } = nativeWorld();
    gateway.getDocument.mockResolvedValue(null);
    const missing = await make(WRITE).run({ budgetMs: 10_000 });
    expect(missing.waiting).toMatchObject({ native_entry_manifest_missing: 1 });
    expect(gate.check).not.toHaveBeenCalled();
    expect(store.held.get(EN)).toEqual({
      reason: 'manifest_missing',
      retryAt: NOW + retryDelayMs(1),
      attempts: 1
    });
    // Before the wait is over: not asked; after it: asked, the wait doubles.
    store.state = { ...store.state, lastFullAt: 1 };
    await make(WRITE, NOW + 30_000).run({ budgetMs: 10_000 });
    expect(gateway.getDocument).toHaveBeenCalledTimes(1);
    store.state = { ...store.state, lastFullAt: 1 };
    await make(WRITE, NOW + retryDelayMs(1)).run({ budgetMs: 10_000 });
    expect(gateway.getDocument).toHaveBeenCalledTimes(2);
    expect(store.held.get(EN)).toMatchObject({
      attempts: 2,
      retryAt: NOW + retryDelayMs(1) + retryDelayMs(2)
    });
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(30)).toBe(6 * 3_600_000);
  });

  it('asks moderation again later when it gives no verdict, and writes the entry once it does', async () => {
    const { store, gate, make } = nativeWorld();
    gate.check.mockResolvedValueOnce({
      kind: 'deferred',
      code: 'CONTENT_MODERATION_REVIEW_LIMIT'
    });
    const first = await make(WRITE).run({ budgetMs: 10_000 });
    expect(first.waiting).toMatchObject({
      native_entry_held_moderation_deferred: 1
    });
    expect(store.held.get(EN)).toMatchObject({
      reason: 'moderation_deferred',
      attempts: 1
    });
    store.state = { ...store.state, lastFullAt: 1 };
    const later = await make(WRITE, NOW + retryDelayMs(1)).run({
      budgetMs: 10_000
    });
    expect(later.changes.drops).toEqual({ insert: 1, update: 0, delete: 0 });
    expect(store.held.has(EN)).toBe(false);
  });

  it('holds for good a manifest that can never check', async () => {
    const { store, gateway, gate, make } = nativeWorld();
    gateway.getDocument.mockResolvedValue(Buffer.from(other.bytes));
    store.chain.get(D1)!.entries[0].data.contentCid = other.contentCid;
    await make(WRITE).run({ budgetMs: 10_000 });
    expect(store.held.get(EN)).toEqual({
      reason: 'commitment_mismatch',
      retryAt: null,
      attempts: 1
    });
    expect(gate.check).not.toHaveBeenCalled();
  });
});
