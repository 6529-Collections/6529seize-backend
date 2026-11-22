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
  parseMainStageDecisionIds
} from './waves-chain-index.claims';
import { EMPTY_INDEX_STATE } from './waves-chain-index.db';
import { ChainEvent } from './waves-chain-index.events';
import { WavesChainIndex } from './waves-chain-index.service';

const BIG = 1_000_000;
const W1 = id('a1');
const D1 = id('d1');
const D4 = id('d4');
const E = (n: number) => id(`e${n}`);
const V = (n: number) => id(`f${n}`);
const DROP = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const manifest = (entryId: string) => id(`fe${entryId.slice(-8)}`);

/**
 * The claim builder's check of `chain` (the mint lane's
 * parseChainClaimContext): ids 0x and 64 lowercase hex, an occurrence of 0
 * or more, a height above 0.
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
  enabled() {
    return this.on;
  }
  mainStage() {
    return this.ids;
  }
  async send(message: ClaimBuildMessage) {
    if (this.failures > 0) {
      this.failures--;
      throw new Error('queue down');
    }
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

  it('does nothing with the setting off, nor for results from before it was on', async () => {
    queue.on = false;
    chain.settle(D1, 3, [E(1)], 8);
    const off = await index.run({ budgetMs: BIG });
    expect(off.claimBuilds).toEqual({ queued: 0, sent: 0, failed: 0 });
    queue.on = true;
    await index.run({ budgetMs: BIG });
    expect(queue.sent).toEqual([]);
    expect(db.claims.size).toBe(0);
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
