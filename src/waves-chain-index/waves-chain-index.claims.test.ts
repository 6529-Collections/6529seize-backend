import { Logger } from '@/logging';
import {
  FakeChain,
  FakeClock,
  FakeIndexDb,
  id
} from '@/tests/fixtures/waves-chain-index.fixture';
import {
  ClaimBuildMessage,
  ClaimBuildPort,
  claimBuildsOf,
  parseMainStageDecisionIds,
  resultFinalEventOf
} from './waves-chain-index.claims';
import { EMPTY_INDEX_STATE, WavesChainIndexDb } from './waves-chain-index.db';
import { ChainEvent } from './waves-chain-index.events';
import {
  CLAIM_CATCH_UP_PER_RUN,
  WavesChainIndex
} from './waves-chain-index.service';

const BIG = 1_000_000;
const W1 = id('a1');
const D1 = id('d1');
const D4 = id('d4');
const E = (n: number) => id(`e${n}`);
const V = (n: number) => id(`f${n}`);
const DROP = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const manifest = (entryId: string) => id(`fe${entryId.slice(-8)}`);

/**
 * The claim builder's check of `chain` (parseChainClaimContext in
 * src/mint-log/mint-claim-build.ts): ids 0x and 64 lowercase hex, an
 * occurrence of 0 or more, a height above 0.
 */
function claimBuilderAccepts(message: ClaimBuildMessage): boolean {
  const hex = /^0x[0-9a-f]{64}$/;
  const chain = message.chain;
  return (
    typeof message.drop_id === 'string' &&
    message.drop_id.trim().length > 0 &&
    hex.test(chain.decision_id) &&
    hex.test(chain.entry_id) &&
    hex.test(chain.manifest_hash) &&
    Number.isSafeInteger(chain.occurrence) &&
    chain.occurrence >= 0 &&
    Number.isSafeInteger(chain.height) &&
    chain.height > 0
  );
}

class FakeQueue implements ClaimBuildPort {
  on = true;
  ids: ReadonlySet<string> = new Set([D1]);
  readonly sent: ClaimBuildMessage[] = [];
  failures = 0;
  afterSend: (() => void) | null = null;
  // Freezes and sends in order, and freezes that fail first.
  readonly log: string[] = [];
  freezeFailures = 0;
  enabled() {
    return this.on;
  }
  mainStage() {
    return this.ids;
  }
  async freezeCollaboration(dropId: string) {
    if (this.freezeFailures > 0) {
      this.freezeFailures--;
      throw new Error('collaboration row locked');
    }
    this.log.push(`freeze ${dropId}`);
  }
  async send(message: ClaimBuildMessage) {
    if (this.failures > 0) {
      this.failures--;
      throw new Error('queue down');
    }
    this.log.push(`send ${message.drop_id}`);
    this.sent.push(JSON.parse(JSON.stringify(message)));
    this.afterSend?.();
    return `m-${this.sent.length}`;
  }
}

/** D1 the Main Stage (listed), D4 another decision; imported and native entries. */
function aWorld(clock: FakeClock): FakeChain {
  const chain = new FakeChain(clock);
  chain.putWave(W1);
  chain.putDecision(D1, W1, { counted: true });
  chain.putDecision(D4, W1);
  chain.putEntry(E(1), D1, { legacyId: DROP(1), origin: 'legacy' });
  chain.putEntry(E(2), D1, { legacyId: DROP(2), origin: 'legacy' });
  chain.putEntry(E(3), D1); // created on the chain: no 6529.io drop
  chain.putEntry(E(4), D4, { legacyId: DROP(4), origin: 'legacy' });
  chain.vote(E(1), V(1), 5);
  chain.vote(E(2), V(2), 9);
  return chain;
}

describe('Main Stage claim builds', () => {
  let clock: FakeClock;
  let chain: FakeChain;
  let queue: FakeQueue;
  let db: FakeIndexDb;
  let index: WavesChainIndex;

  beforeEach(async () => {
    clock = new FakeClock();
    chain = aWorld(clock);
    queue = new FakeQueue();
    db = new FakeIndexDb();
    index = new WavesChainIndex(chain, db.asDb(), clock.now, undefined, queue);
    await index.run({ budgetMs: BIG });
  });

  it('queues one claim build for the rank-1 entry of a decided Main Stage result', async () => {
    chain.settle(D4, 1, [E(4)]); // not the Main Stage
    chain.settle(D1, 2, [], 2); // skipped: no winner
    chain.settle(D1, 3, [E(2), E(1)], 3);
    const settled = chain.height;
    const report = await index.run({ budgetMs: BIG });
    expect(report.claimBuilds).toEqual({ queued: 1, sent: 1, failed: 0 });
    expect(queue.sent).toEqual([
      {
        drop_id: DROP(2),
        chain: {
          decision_id: D1,
          occurrence: 3,
          entry_id: E(2),
          height: settled,
          manifest_hash: manifest(E(2))
        }
      }
    ]);
    expect(claimBuilderAccepts(queue.sent[0])).toBe(true);
    expect(Object.keys(queue.sent[0])).toEqual(['drop_id', 'chain']);
    expect(Array.from(db.claims.values())).toEqual([
      expect.objectContaining({
        decisionId: D1,
        occurrence: 3,
        status: 'sent',
        attempts: 1,
        messageId: 'm-1'
      })
    ]);
    // Nothing more on later runs.
    await index.run({ budgetMs: BIG });
    expect(queue.sent).toHaveLength(1);
  });

  it('sends nothing for an entry created on the chain, and says why', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    chain.settle(D1, 3, [E(3)], 4);
    const report = await index.run({ budgetMs: BIG });
    expect(report.claimBuilds.queued).toBe(0);
    expect(queue.sent).toEqual([]);
    expect(Array.from(db.claims.values())).toEqual([
      expect.objectContaining({
        entryId: E(3),
        dropId: null,
        message: null,
        status: 'skipped',
        reason: 'entry created on the chain: no 6529.io drop'
      })
    ]);
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes(E(3)))
    ).toHaveLength(1);
    warn.mockRestore();
  });

  it('keeps a build whose send failed, and sends it once on a later run', async () => {
    queue.failures = 1;
    chain.settle(D1, 3, [E(1)], 5);
    const first = await index.run({ budgetMs: BIG });
    expect(first.claimBuilds).toEqual({ queued: 1, sent: 0, failed: 1 });
    expect(queue.sent).toEqual([]);
    expect(Array.from(db.claims.values())[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'queue down'
    });
    const second = await index.run({ budgetMs: BIG });
    expect(second.claimBuilds).toEqual({ queued: 0, sent: 1, failed: 0 });
    await index.run({ budgetMs: BIG });
    expect(queue.sent.map((m) => m.chain.occurrence)).toEqual([5]);
    expect(Array.from(db.claims.values())[0]).toMatchObject({
      status: 'sent',
      attempts: 2
    });
  });

  it('a run that fails after its sends sends nothing again', async () => {
    chain.settle(D1, 3, [E(1)], 6);
    // What moves with time is read after the sends: it fails.
    queue.afterSend = () => {
      chain.failOn = 'decision';
    };
    await expect(index.run({ budgetMs: BIG })).rejects.toThrow(
      'decision failed'
    );
    expect(queue.sent).toHaveLength(1);
    queue.afterSend = null;
    chain.failOn = null;
    await index.run({ budgetMs: BIG });
    expect(queue.sent).toHaveLength(1);
  });

  it('sends nothing again when the log is rebuilt over the result', async () => {
    const before = chain.height + 1;
    chain.settle(D1, 3, [E(1)], 7);
    await index.run({ budgetMs: BIG });
    expect(queue.sent).toHaveLength(1);
    // The index and its log emptied, the feed replayed from before the
    // result: the result is logged again, its claim build is not.
    await db.clearAll();
    db.state = {
      ...EMPTY_INDEX_STATE,
      network: db.state.network,
      feedNext: before,
      readHeight: db.state.readHeight
    };
    await index.run({ budgetMs: BIG });
    expect(
      db.events.filter((e) => e.kind === 'RESULT_FINAL').map((e) => e.height)
    ).toEqual([before]);
    expect(queue.sent).toHaveLength(1);
    expect(db.claims.size).toBe(1);
  });

  it('does nothing with the setting off, and catches a result logged then up once it is on', async () => {
    queue.on = false;
    chain.settle(D1, 3, [E(1)], 8);
    const settled = chain.height;
    const off = await index.run({ budgetMs: BIG });
    expect(off.claimBuilds).toEqual({ queued: 0, sent: 0, failed: 0 });
    expect(db.claims.size).toBe(0);
    await index.run({ budgetMs: BIG });
    expect(queue.sent).toEqual([]);
    queue.on = true;
    const on = await index.run({ budgetMs: BIG });
    expect(on.claimBuilds).toEqual({ queued: 1, sent: 1, failed: 0 });
    // As the log would have queued it: the same message, frozen first.
    expect(queue.sent).toEqual([
      {
        drop_id: DROP(1),
        chain: {
          decision_id: D1,
          occurrence: 8,
          entry_id: E(1),
          height: settled,
          manifest_hash: manifest(E(1))
        }
      }
    ]);
    expect(queue.log).toEqual([`freeze ${DROP(1)}`, `send ${DROP(1)}`]);
    // Never twice.
    await index.run({ budgetMs: BIG });
    await index.run({ budgetMs: BIG });
    expect(queue.sent).toHaveLength(1);
    expect(db.claims.size).toBe(1);
  });

  it('catches up a result logged while MAIN_STAGE_DECISION_IDS named another decision, once corrected', async () => {
    queue.ids = new Set([D4]);
    chain.settle(D1, 3, [E(2)], 12);
    await index.run({ budgetMs: BIG });
    expect(db.claims.size).toBe(0);
    queue.ids = new Set([D1]);
    const corrected = await index.run({ budgetMs: BIG });
    expect(corrected.claimBuilds).toEqual({ queued: 1, sent: 1, failed: 0 });
    expect(queue.sent.map((m) => [m.drop_id, m.chain.occurrence])).toEqual([
      [DROP(2), 12]
    ]);
    await index.run({ budgetMs: BIG });
    expect(queue.sent).toHaveLength(1);
  });

  it('catches up nothing for a decision not listed, nor a result already built', async () => {
    chain.settle(D4, 1, [E(4)], 13); // not the Main Stage
    chain.settle(D1, 3, [E(1)], 14);
    await index.run({ budgetMs: BIG });
    expect(queue.sent.map((m) => m.chain.decision_id)).toEqual([D1]);
    for (let run = 0; run < 3; run++) await index.run({ budgetMs: BIG });
    expect(queue.sent).toHaveLength(1);
    expect(Array.from(db.claims.keys())).toEqual([
      `${db.state.network ?? ''}|${D1}|14`
    ]);
  });
  it("freezes the winner's collaboration for the mint before its claim build is sent, once", async () => {
    chain.settle(D1, 3, [E(2), E(1)], 3);
    await index.run({ budgetMs: BIG });
    expect(queue.log).toEqual([`freeze ${DROP(2)}`, `send ${DROP(2)}`]);
    await index.run({ budgetMs: BIG });
    expect(queue.log).toHaveLength(2);
  });

  it('sends nothing while the freeze fails, logged as its own line, and freezes and sends on a later run', async () => {
    const error = jest.spyOn(Logger.prototype, 'error');
    queue.freezeFailures = 1;
    chain.settle(D1, 3, [E(1)], 9);
    const first = await index.run({ budgetMs: BIG });
    expect(first.claimBuilds).toEqual({ queued: 1, sent: 0, failed: 1 });
    expect(queue.log).toEqual([]);
    const lines = error.mock.calls.map(([message]) => String(message));
    expect(
      lines.filter((line) =>
        line.startsWith('[CLAIM BUILD COLLABORATION FREEZE FAILED]')
      )
    ).toEqual([
      `[CLAIM BUILD COLLABORATION FREEZE FAILED] decision ${D1} occurrence 9, attempt 1: collaboration row locked`
    ]);
    expect(
      lines.filter((line) => line.startsWith('[CLAIM BUILD SEND FAILED]'))
    ).toEqual([]);
    error.mockRestore();
    expect(Array.from(db.claims.values())[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'collaboration row locked'
    });
    const second = await index.run({ budgetMs: BIG });
    expect(second.claimBuilds).toEqual({ queued: 0, sent: 1, failed: 0 });
    expect(queue.log).toEqual([`freeze ${DROP(1)}`, `send ${DROP(1)}`]);
  });

  it('freezes nothing for a winner made on the chain (no 6529.io drop), nor with the setting off', async () => {
    chain.settle(D1, 3, [E(3)], 10);
    await index.run({ budgetMs: BIG });
    queue.on = false;
    chain.settle(D1, 3, [E(1)], 11);
    await index.run({ budgetMs: BIG });
    expect(queue.log).toEqual([]);
  });

  it('sends with a port that has no freeze', async () => {
    const plain = new FakeQueue();
    const bare: ClaimBuildPort = {
      enabled: () => plain.enabled(),
      mainStage: () => plain.mainStage(),
      send: (message) => plain.send(message)
    };
    const other = new WavesChainIndex(
      chain,
      db.asDb(),
      clock.now,
      undefined,
      bare
    );
    chain.settle(D1, 3, [E(1)], 12);
    await other.run({ budgetMs: BIG });
    expect(plain.log).toEqual([`send ${DROP(1)}`]);
  });

  it('raises an alarm when a feed gap may hide a Main Stage result', async () => {
    const error = jest.spyOn(Logger.prototype, 'error');
    // Settled where the feed no longer reaches: the log gets a GAP, no event.
    chain.settle(D1, 3, [E(2)], 3);
    chain.goneBelow = chain.height + 1;
    const report = await index.run({ budgetMs: BIG });
    expect(report.restartedFull).toBe('feed_gone');
    expect(queue.sent).toEqual([]);
    expect(
      error.mock.calls.filter(([message]) =>
        String(message).startsWith('[CLAIM BUILD GAP]')
      )
    ).toHaveLength(1);
    expect(String(error.mock.calls[0][0])).toContain(D1);
    error.mockClear();
    // Off, or with no Main Stage listed, a gap is only the GAP event.
    queue.ids = new Set();
    chain.goneBelow = chain.height + 1;
    chain.vote(E(1), V(1), 6);
    await index.run({ budgetMs: BIG });
    expect(
      error.mock.calls.filter(([message]) =>
        String(message).startsWith('[CLAIM BUILD GAP]')
      )
    ).toHaveLength(0);
    error.mockRestore();
  });
});

describe('claimBuildsOf', () => {
  const result = (fields: Partial<ChainEvent>, data: Record<string, unknown>) =>
    ({
      height: 50,
      seq: 0,
      blockTime: 1,
      kind: 'RESULT_FINAL',
      origin: 'OPERATION',
      waveId: W1,
      waveLegacyId: null,
      decisionId: D1,
      decisionLegacyId: null,
      entryId: null,
      entryLegacyId: null,
      pollId: null,
      pollLegacyId: null,
      groupId: null,
      groupLegacyId: null,
      actor: null,
      ...fields,
      data: {
        resultTime: 9,
        occurrence: 2,
        status: 'decided',
        winners: [
          {
            entryId: E(2),
            rank: 2,
            score: '1',
            legacyId: DROP(2),
            manifestHash: manifest(E(2))
          },
          {
            entryId: E(1),
            rank: 1,
            score: '5',
            legacyId: DROP(1),
            manifestHash: manifest(E(1))
          }
        ],
        ...data
      }
    }) as ChainEvent;
  const main = new Set([D1]);

  it('takes the rank-1 winner of a decided result of a listed decision', () => {
    expect(claimBuildsOf([result({}, {})], main, 'net-1')).toEqual([
      {
        network: 'net-1',
        decisionId: D1,
        occurrence: 2,
        height: 50,
        entryId: E(1),
        dropId: DROP(1),
        message: {
          drop_id: DROP(1),
          chain: {
            decision_id: D1,
            occurrence: 2,
            entry_id: E(1),
            height: 50,
            manifest_hash: manifest(E(1))
          }
        },
        status: 'pending',
        reason: null
      }
    ]);
  });

  it('leaves out other decisions, other results and other events', () => {
    expect(claimBuildsOf([result({}, {})], new Set(), 'n')).toEqual([]);
    expect(
      claimBuildsOf([result({}, { status: 'skipped' })], main, 'n')
    ).toEqual([]);
    expect(claimBuildsOf([result({ kind: 'VOTE' }, {})], main, 'n')).toEqual(
      []
    );
    expect(claimBuildsOf([result({}, { winners: [] })], main, 'n')).toEqual([]);
  });

  it('writes, without a message, a winner it cannot send', () => {
    const noManifest = result(
      {},
      { winners: [{ entryId: E(1), rank: 1, legacyId: DROP(1) }] }
    );
    expect(claimBuildsOf([noManifest], main, null)[0]).toMatchObject({
      network: '',
      status: 'skipped',
      reason: 'no manifest hash',
      message: null
    });
  });
});

describe('parseMainStageDecisionIds', () => {
  it('reads 0x and 64 hex digits a comma, in lowercase, and leaves out the rest, logged once', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const bad = `0x${'g'.repeat(64)}`;
    const value = ` ${D1},${D4.toUpperCase().replace('0X', '0x')},, ${bad},nope,${D1}`;
    expect(Array.from(parseMainStageDecisionIds(value))).toEqual([D1, D4]);
    expect(Array.from(parseMainStageDecisionIds(value))).toEqual([D1, D4]);
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes(bad))
    ).toHaveLength(1);
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes('"nope"'))
    ).toHaveLength(1);
    warn.mockRestore();
    expect(parseMainStageDecisionIds('').size).toBe(0);
    expect(parseMainStageDecisionIds(undefined).size).toBe(0);
  });
});

describe('the claim build catch-up', () => {
  it('reads the log once a run, for the listed decisions, at most 50', async () => {
    const clock = new FakeClock();
    const chain = aWorld(clock);
    const queue = new FakeQueue();
    const db = new FakeIndexDb();
    const index = new WavesChainIndex(
      chain,
      db.asDb(),
      clock.now,
      undefined,
      queue
    );
    await index.run({ budgetMs: BIG });
    const read = jest.spyOn(db, 'resultsWithoutClaimBuild');
    await index.run({ budgetMs: BIG });
    expect(CLAIM_CATCH_UP_PER_RUN).toBe(50);
    expect(read.mock.calls).toEqual([[[D1], db.state.network ?? '', 50]]);
    queue.on = false;
    await index.run({ budgetMs: BIG });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("asks the database for the index's final, decided, native results with no build on its network", async () => {
    const calls: { sql: string; params: Record<string, unknown> }[] = [];
    const executor = {
      execute: async (sql: string, params: Record<string, unknown>) => {
        calls.push({ sql, params });
        return [];
      },
      executeNativeQueriesInTransaction: async (work: any) =>
        work({ connection: {} })
    };
    const sqlDb = new WavesChainIndexDb(() => executor as any);
    expect(await sqlDb.resultsWithoutClaimBuild([], 'net', 50)).toEqual([]);
    expect(calls).toEqual([]);
    await sqlDb.resultsWithoutClaimBuild([D1], 'net', 50);
    const sql = calls[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain('from chain_results r');
    expect(sql).toContain('r.decision_id in (:decisionIds)');
    expect(sql).toContain(
      "r.stage = 'final' and r.status = 'decided' and r.origin = 'native'"
    );
    expect(sql).toContain('b.network = :network');
    expect(sql).toContain('order by r.result_time limit :limit');
    expect(calls[0].params).toEqual({
      decisionIds: [D1],
      network: 'net',
      limit: 50
    });
    calls.length = 0;
    await sqlDb.writeClaimBuilds([]);
    expect(calls).toEqual([]);
  });
});

describe('a Main Stage result the event log never saw', () => {
  const fresh = () => {
    const clock = new FakeClock();
    const chain = aWorld(clock);
    const queue = new FakeQueue();
    const db = new FakeIndexDb();
    const index = new WavesChainIndex(
      chain,
      db.asDb(),
      clock.now,
      undefined,
      queue
    );
    return { clock, chain, queue, db, index };
  };

  it('gets one build when it went final before the index first read the chain', async () => {
    const { chain, queue, db, index } = fresh();
    // Settled right after the import, before the index's first run: its
    // block is at or below the height the log starts above.
    chain.settle(D1, 3, [E(2), E(1)], 16);
    const settled = chain.height;
    await index.run({ budgetMs: BIG });
    expect(db.events.filter((e) => e.kind === 'RESULT_FINAL')).toEqual([]);
    await index.run({ budgetMs: BIG });
    expect(queue.sent).toEqual([
      {
        drop_id: DROP(2),
        chain: {
          decision_id: D1,
          occurrence: 16,
          entry_id: E(2),
          height: settled,
          manifest_hash: manifest(E(2))
        }
      }
    ]);
    expect(queue.log).toEqual([`freeze ${DROP(2)}`, `send ${DROP(2)}`]);
    for (let run = 0; run < 3; run++) await index.run({ budgetMs: BIG });
    expect(queue.sent).toHaveLength(1);
  });

  it('gets none when the import carried it (6529.io counted it)', async () => {
    const { chain, queue, db, index } = fresh();
    chain.settle(D1, 3, [E(1)], 15, 'legacy');
    for (let run = 0; run < 3; run++) await index.run({ budgetMs: BIG });
    expect(queue.sent).toEqual([]);
    expect(db.claims.size).toBe(0);
  });

  it('builds the same message whichever path finds it first', async () => {
    const logged = fresh();
    logged.chain.settle(D4, 1, [E(4)], 2); // first block after the first run
    await logged.index.run({ budgetMs: BIG });
    logged.chain.settle(D1, 3, [E(1)], 17);
    await logged.index.run({ budgetMs: BIG });
    const fromLog = logged.queue.sent;
    const caught = fresh();
    caught.chain.settle(D4, 1, [E(4)], 2);
    caught.chain.settle(D1, 3, [E(1)], 17);
    // Claim builds off while it was logged: the catch-up builds it later.
    caught.queue.on = false;
    await caught.index.run({ budgetMs: BIG });
    await caught.index.run({ budgetMs: BIG });
    caught.queue.on = true;
    await caught.index.run({ budgetMs: BIG });
    expect(fromLog).toHaveLength(1);
    expect(caught.queue.sent).toEqual(fromLog);
  });
});

describe('resultFinalEventOf', () => {
  const entries = new Map([
    [E(1), { legacyId: DROP(1), manifestHash: manifest(E(1)) }],
    [E(2), { legacyId: null, manifestHash: manifest(E(2)) }],
    [E(3), { legacyId: DROP(3), manifestHash: null }]
  ]);
  const result = (fields: Record<string, unknown> = {}) => ({
    resultTime: 3,
    occurrence: 7,
    status: 'decided',
    settledHeight: 40,
    winners: [
      { entryId: E(1).toUpperCase().replace('0X', '0x'), rank: 1, score: '9' },
      { entryId: E(2), rank: 2, score: '5' }
    ],
    ...fields
  });

  it('gives the RESULT_FINAL the log writes: the block it went final in, the winners with legacy id and manifest', () => {
    expect(resultFinalEventOf(D1, result(), entries)).toEqual(
      expect.objectContaining({
        height: 40,
        kind: 'RESULT_FINAL',
        decisionId: D1,
        data: expect.objectContaining({
          occurrence: 7,
          status: 'decided',
          winners: [
            {
              entryId: E(1),
              rank: 1,
              score: '9',
              legacyId: DROP(1),
              manifestHash: manifest(E(1))
            },
            {
              entryId: E(2),
              rank: 2,
              score: '5',
              legacyId: null,
              manifestHash: manifest(E(2))
            }
          ]
        })
      })
    );
  });

  it("waits while the rank-1 entry or its manifest isn't in the index, or no block is named", () => {
    expect(
      resultFinalEventOf(
        D1,
        result({ winners: [{ entryId: E(9), rank: 1 }] }),
        entries
      )
    ).toBeNull();
    expect(
      resultFinalEventOf(
        D1,
        result({ winners: [{ entryId: E(3), rank: 1 }] }),
        entries
      )
    ).toBeNull();
    expect(
      resultFinalEventOf(D1, result({ settledHeight: 0 }), entries)
    ).toBeNull();
    expect(resultFinalEventOf(D1, result({ winners: [] }), entries)).toBeNull();
  });
});
