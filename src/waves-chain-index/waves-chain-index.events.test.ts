import {
  FakeChain,
  FakeClock,
  FakeIndexDb,
  id
} from '@/tests/fixtures/waves-chain-index.fixture';
import { ChainFeedPage } from '@/chain-gateway/chain-gateway.types';
import {
  ChainEvent,
  choicesOf,
  deriveEvents,
  emptyEventContext,
  eventCursor,
  EventCursorError,
  parseEventCursor,
  TRUST_ALL,
  UNKNOWN_SCAN
} from './waves-chain-index.events';
import { fullReadCovers, WavesChainIndex } from './waves-chain-index.service';
import { compareCodeUnits } from './waves-chain-index.order';

const BIG = 1_000_000;
const G1 = id('91');
const G2 = id('92');
const G3 = id('93');
const W1 = id('a1');
const W2 = id('a2');
const W3 = id('a3');
const P1 = id('b1');
const D1 = id('d1');
const D2 = id('d2');
const D3 = id('d3');
const E = (n: number) => id(`e${n}`);
const V = (n: number) => id(`f${n}`);
const C = (n: number) => id(`c${n}`);

/** A gateway whose feed holds one block less than its head says. */
class FeedOneBehind extends FakeChain {
  async feed(from: number): Promise<ChainFeedPage> {
    const page = await super.feed(from);
    const through = Math.min(page.through, this.height - 1);
    const blocks = page.blocks.filter((b) => b.height <= through);
    return { ...page, blocks, through, next: through + 1 };
  }
}

/** The world of the index's tests: two waves, three decisions, votes. */
function aWorld(
  clock: FakeClock,
  make: (clock: FakeClock) => FakeChain = (c) => new FakeChain(c)
): FakeChain {
  const chain = make(clock);
  chain.putGroup(G1);
  chain.putGroup(G2, { legacyId: 'ABC-1' });
  chain.putWave(W1, {
    legacyId: '8FE9-W1',
    readGroup: { groupId: G1, version: 0 },
    membersOnly: true
  });
  chain.putWave(W2);
  chain.putPoll(P1, W1, { legacyId: 'B1B1-P1' });
  chain.putDecision(D1, W1, {
    legacyId: 'DDDD-1',
    counted: true,
    nextResultTime: clock.t + 3600_000
  });
  chain.putDecision(D2, W2, { status: 'ended' });
  chain.putDecision(D3, W2, { kind: 'approve' });
  chain.putEntry(E(1), D1, { legacyId: 'EEEE-1', origin: 'legacy' });
  chain.putEntry(E(2), D1);
  chain.putEntry(E(3), D1);
  chain.putEntry(E(6), D3);
  chain.vote(E(1), V(1), 5);
  chain.vote(E(1), V(2), 3);
  chain.vote(E(2), V(1), 1);
  chain.vote(E(3), V(3), 2);
  chain.vote(E(6), V(2), 4);
  return chain;
}

const logs: FakeIndexDb[] = [];

afterEach(() => {
  for (const db of logs.splice(0)) expect(db.derivedOtherwise).toEqual([]);
});

function indexOf(chain: FakeChain, clock: FakeClock) {
  const db = new FakeIndexDb();
  logs.push(db);
  const index = new WavesChainIndex(chain, db.asDb(), clock.now);
  return { db, index };
}

/** Every change kind the log knows, in a fixed order. */
function moves(chain: FakeChain) {
  return [
    () => chain.vote(E(1), V(1), 6), // changed
    () => chain.vote(E(3), V(4), 4), // new
    () => chain.vote(E(2), V(1), 0), // removed by its voter
    () => chain.cut(E(1), V(2), 2), // cut by the scan
    () => chain.cut(E(3), V(3), 0), // cut to nothing
    () => chain.vote(E(2), V(5), 2),
    () => chain.putEntry(E(2), D1, { status: 'withdrawn' }),
    () => chain.release(E(2), V(5)),
    () => chain.putEntry(E(5), D1),
    () => chain.vote(E(5), V(2), 1),
    () => chain.putWave(W3, { postGroup: { groupId: G2, version: 0 } }, C(7)),
    () => chain.putWave(W3, { readGroup: { groupId: G1, version: 0 } }),
    () => chain.putWave(W3, { membersOnly: true }), // no new policy
    () => chain.putGroup(G3, { includes: [{ kind: 1, value: V(1) }] }),
    () => chain.putGroup(G3),
    () => chain.ballot(P1, C(1), 0b011),
    () => chain.ballot(P1, C(1), 0b100),
    () => chain.ballot(P1, C(2), 0b001),
    () => chain.putResult(D1, 1, { status: 'counting', stage: 'scoring' }),
    () => chain.moderate(W1, E(3), V(9)),
    () => chain.settle(D1, 1, [E(1)]),
    () => chain.closePoll(P1)
  ];
}

const withoutPlace = ({ height: _h, seq: _s, ...rest }: ChainEvent) => rest;

describe('the chain index event log', () => {
  let clock: FakeClock;
  let chain: FakeChain;

  beforeEach(() => {
    clock = new FakeClock();
    chain = aWorld(clock);
  });

  it('logs nothing for a full read', async () => {
    const { db, index } = indexOf(chain, clock);
    const report = await index.run({ budgetMs: BIG });
    expect(report.full.completed).toBe(true);
    expect(report.events).toBe(0);
    expect(db.events).toEqual([]);
    // A day later, the next full read logs nothing either.
    chain.tick(1000);
    clock.t += 25 * 3600_000;
    const again = await index.run({ budgetMs: BIG });
    expect(again.full).toMatchObject({ started: true, completed: true });
    expect(db.events).toEqual([]);
  });

  it('logs each change once, with what was there before', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    const start = chain.height;
    for (const move of moves(chain)) move();
    const report = await index.run({ budgetMs: BIG });
    expect(report.feedBatches).toBeGreaterThan(1);
    const events = db.events;
    expect(report.events).toBe(events.length);
    expect(db.state.eventsNext).toBe(chain.height + 1);
    // Every block after the full read, in order, one place each.
    expect(events.every((e) => e.height > start)).toBe(true);
    expect(events.map((e) => eventCursor(e))).toEqual(
      [...events]
        .sort((a, b) => a.height - b.height || a.seq - b.seq)
        .map((e) => eventCursor(e))
    );
    const blockTimes = new Map(chain.blocks.map((b) => [b.height, b.time]));
    for (const e of events) expect(e.blockTime).toBe(blockTimes.get(e.height));

    const votes = events.filter((e) => e.kind === 'VOTE');
    expect(
      votes.map((e) => [
        e.entryId,
        e.actor,
        e.data.oldValue,
        e.data.newValue,
        e.data.entryTotalAfter,
        e.origin
      ])
    ).toEqual([
      [E(1), V(1), '5', '6', '9', 'OPERATION'],
      [E(3), V(4), '0', '4', '6', 'OPERATION'],
      [E(2), V(1), '1', '0', '0', 'OPERATION'],
      [E(1), V(2), '3', '2', '8', 'SCAN'],
      [E(3), V(3), '2', '0', '4', 'SCAN'],
      [E(2), V(5), '0', '2', '2', 'OPERATION'],
      [E(2), V(5), '2', '0', '2', 'RELEASE'],
      [E(5), V(2), '0', '1', '1', 'OPERATION']
    ]);
    expect(votes[0]).toMatchObject({
      waveId: W1,
      waveLegacyId: '8fe9-w1',
      decisionId: D1,
      decisionLegacyId: 'dddd-1',
      entryLegacyId: 'eeee-1',
      data: { voter: V(1), entryAuthor: id('a1') }
    });

    const kinds = (kind: string) => events.filter((e) => e.kind === kind);
    expect(kinds('ENTRY_CREATED')).toEqual([
      expect.objectContaining({
        entryId: E(5),
        decisionId: D1,
        waveId: W1,
        entryLegacyId: null,
        actor: id('a1'),
        data: expect.objectContaining({ author: id('a1') })
      })
    ]);
    expect(
      kinds('ENTRY_RELEASED').map((e) => [
        e.entryId,
        e.data.reason,
        e.data.status,
        e.data.creditScope,
        e.data.creditSource
      ])
    ).toEqual([
      [E(2), 'WITHDRAWN', 'withdrawn', 'decision', 'tdh'],
      [E(3), 'DISQUALIFIED', 'disqualified', 'decision', 'tdh'],
      [E(1), 'WIN', 'winner', 'decision', 'tdh']
    ]);
    expect(kinds('ENTRY_RELEASED')[2].data).toMatchObject({
      rank: 1,
      resultTime: 1,
      total: '8'
    });
    expect(kinds('RESULT_FINAL')).toEqual([
      expect.objectContaining({
        decisionId: D1,
        waveId: W1,
        data: expect.objectContaining({
          resultTime: 1,
          occurrence: 1,
          status: 'decided',
          winnerCount: 1,
          winners: [
            {
              entryId: E(1),
              rank: 1,
              score: '8',
              legacyId: 'eeee-1',
              manifestHash: id(`fe${E(1).slice(-8)}`)
            }
          ]
        })
      })
    ]);
    expect(kinds('MODERATION')).toEqual([
      expect.objectContaining({
        waveId: W1,
        entryId: E(3),
        decisionId: D1,
        actor: V(9),
        data: expect.objectContaining({ action: 'disqualify', decidedBy: V(9) })
      })
    ]);
    expect(kinds('WAVE_CREATED')).toEqual([
      expect.objectContaining({
        waveId: W3,
        actor: C(7),
        data: expect.objectContaining({
          creator: C(7),
          controller: id('c0'),
          policyVersion: 1,
          readGroupId: null,
          postGroupId: G2,
          adminGroupId: null,
          groupIds: [G2]
        })
      })
    ]);
    expect(kinds('WAVE_POLICY_REPLACED')).toEqual([
      expect.objectContaining({
        waveId: W3,
        data: expect.objectContaining({
          policyVersion: 2,
          readGroupId: G1,
          postGroupId: G2,
          groupIds: [G1, G2]
        })
      })
    ]);
    expect(
      kinds('GROUP_CREATED').map((e) => [e.groupId, e.data.includes])
    ).toEqual([[G3, [{ kind: 1, value: V(1) }]]]);
    expect(
      kinds('GROUP_REPLACED').map((e) => [e.groupId, e.data.version])
    ).toEqual([[G3, 2]]);
    expect(
      kinds('POLL_BALLOT').map((e) => [
        e.pollId,
        e.pollLegacyId,
        e.waveId,
        e.actor,
        e.data.oldChoices,
        e.data.newChoices
      ])
    ).toEqual([
      [P1, 'b1b1-p1', W1, C(1), [], [0, 1]],
      [P1, 'b1b1-p1', W1, C(1), [0, 1], [2]],
      [P1, 'b1b1-p1', W1, C(2), [], [0]]
    ]);
    // A poll's close and a result still counting are no events.
    expect(new Set(events.map((e) => e.kind)).size).toBe(10);
    expect(events).toHaveLength(8 + 1 + 3 + 1 + 1 + 1 + 1 + 1 + 1 + 3);
  });

  it('reads a ballot before from the log, and votes before from the index, across runs', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    chain.ballot(P1, C(1), 0b001);
    chain.vote(E(1), V(1), 7);
    await index.run({ budgetMs: BIG });
    chain.ballot(P1, C(1), 0b110);
    chain.vote(E(1), V(1), 8);
    await index.run({ budgetMs: BIG });
    expect(
      db.events.map((e) => [e.kind, e.data.oldSelection ?? e.data.oldValue])
    ).toEqual([
      ['POLL_BALLOT', 0],
      ['VOTE', '5'],
      ['POLL_BALLOT', 1],
      ['VOTE', '7']
    ]);
  });

  it('gives the same log run at once, or a page at a time while the chain moves', async () => {
    const once = indexOf(chain, clock);
    const paged = indexOf(chain, clock);
    await once.index.run({ budgetMs: BIG });
    await paged.index.run({ budgetMs: BIG });
    chain.callMs = 10;
    let runs = 0;
    for (const move of moves(chain)) {
      move();
      await paged.index.run({ budgetMs: 45 });
      runs++;
    }
    for (; runs < 200 && paged.db.state.feedNext! <= chain.height; runs++) {
      await paged.index.run({ budgetMs: 45 });
    }
    chain.callMs = 0;
    await once.index.run({ budgetMs: BIG });
    expect(paged.db.events.length).toBeGreaterThan(20);
    expect(paged.db.events).toEqual(once.db.events);
  });

  it('logs a vote-scan block applied in parts across runs once, as one run does', async () => {
    const many = Array.from({ length: 120 }, (_, i) => id(`e${i + 100}`));
    for (const entryId of many) chain.putEntry(entryId, D1);
    for (const entryId of many) chain.vote(entryId, V(6), 9);
    const once = indexOf(chain, clock);
    const parted = indexOf(chain, clock);
    await once.index.run({ budgetMs: BIG });
    await parted.index.run({ budgetMs: BIG });
    // V6's reduction cuts all 120 votes in one block: one batch too large.
    chain.scan(
      [
        {
          voter: V(6),
          decisionId: D1,
          cuts: many.map((entryId) => ({ entryId, value: 4 }))
        }
      ],
      true
    );
    const block = chain.height;
    chain.callMs = 10;
    const parts: number[] = [];
    for (let run = 0; run < 20 && parted.db.state.feedNext! <= block; run++) {
      await parted.index.run({ budgetMs: 300 });
      parts.push(parted.db.state.feedPart);
    }
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.at(-1)).toBe(0);
    chain.callMs = 0;
    await once.index.run({ budgetMs: BIG });
    const scans = parted.db.events.filter((e) => e.height === block);
    expect(scans).toHaveLength(120);
    expect(scans.every((e) => e.origin === 'SCAN')).toBe(true);
    expect(parted.db.events).toEqual(once.db.events);
    expect(parted.db.rows('votes')).toEqual(once.db.rows('votes'));
  });

  it('logs a batch once when its run fails after logging it', async () => {
    const clean = indexOf(chain, clock);
    const failing = indexOf(chain, clock);
    await clean.index.run({ budgetMs: BIG });
    await failing.index.run({ budgetMs: BIG });
    chain.vote(E(1), V(1), 1);
    chain.vote(E(2), V(1), 4);
    chain.failOn = 'entry';
    await expect(failing.index.run({ budgetMs: BIG })).rejects.toThrow(
      'entry failed'
    );
    expect(failing.db.events).toHaveLength(2);
    expect(failing.db.state.eventsNext).toBeGreaterThan(
      failing.db.state.feedNext!
    );
    chain.failOn = null;
    const report = await failing.index.run({ budgetMs: BIG });
    expect(report.events).toBe(0);
    await clean.index.run({ budgetMs: BIG });
    expect(failing.db.events).toEqual(clean.db.events);
  });

  it('reads after a cursor, in the log order, a kind or all', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    for (const move of moves(chain)) move();
    await index.run({ budgetMs: BIG });
    const all = db.events;
    const read: ChainEvent[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const page = await db.readEvents(cursor, 4);
      if (!page.events.length) {
        expect(page.next).toBe(cursor);
        break;
      }
      read.push(...page.events);
      cursor = page.next;
      expect(page.appliedHeight).toBe(chain.height);
      expect(page.network).toBe('net-1');
    }
    expect(read).toEqual(all);
    const middle = eventCursor(all[5]);
    expect((await db.readEvents(middle, 100)).events).toEqual(all.slice(6));
    expect(
      (await db.readEvents(null, 100, ['POLL_BALLOT'])).events.map(
        (e) => e.actor
      )
    ).toEqual([C(1), C(1), C(2)]);
  });

  it('logs from where a rebuild starts what the first index logged there', async () => {
    const first = indexOf(chain, clock);
    await first.index.run({ budgetMs: BIG });
    const all = moves(chain);
    for (const move of all.slice(0, 8)) move();
    await first.index.run({ budgetMs: BIG });
    // A rebuild from empty, read whole at once.
    const rebuilt = indexOf(chain, clock);
    await rebuilt.index.run({ budgetMs: BIG });
    const from = rebuilt.db.state.feedNext!;
    for (const move of all.slice(8)) move();
    await first.index.run({ budgetMs: BIG });
    await rebuilt.index.run({ budgetMs: BIG });
    expect(rebuilt.db.events.length).toBeGreaterThan(5);
    expect(rebuilt.db.events).toEqual(
      first.db.events.filter((e) => e.height >= from)
    );
  });

  it('a rebuild read over many runs knows a vote before only where its full read has been', async () => {
    const first = indexOf(chain, clock);
    await first.index.run({ budgetMs: BIG });
    const rebuilt = indexOf(chain, clock);
    chain.callMs = 10;
    await rebuilt.index.run({ budgetMs: 45 });
    expect(rebuilt.db.state.fullPhase).not.toBeNull();
    const from = rebuilt.db.state.feedNext!;
    let runs = 0;
    for (const move of moves(chain)) {
      move();
      await rebuilt.index.run({ budgetMs: 45 });
      runs++;
    }
    for (; runs < 300 && rebuilt.db.state.fullPhase !== null; runs++) {
      await rebuilt.index.run({ budgetMs: 45 });
    }
    expect(rebuilt.db.state.fullPhase).toBeNull();
    // Once the full read is done, every vote before is known.
    chain.vote(E(6), V(2), 9);
    chain.vote(E(1), V(3), 2);
    chain.callMs = 0;
    await rebuilt.index.run({ budgetMs: BIG });
    await first.index.run({ budgetMs: BIG });
    const expected = first.db.events.filter((e) => e.height >= from);
    const got = rebuilt.db.events;
    expect(got.map((e) => eventCursor(e))).toEqual(
      expected.map((e) => eventCursor(e))
    );
    let unknown = 0;
    got.forEach((event, i) => {
      if (event.kind === 'VOTE' && event.data.oldValue === null) {
        unknown++;
        expect(withoutPlace(event)).toEqual({
          ...withoutPlace(expected[i]),
          data: { ...expected[i].data, oldValue: null }
        });
      } else {
        expect(event).toEqual(expected[i]);
      }
    });
    // Some votes came before the full read got to their decision.
    expect(unknown).toBeGreaterThan(0);
    expect(unknown).toBeLessThan(got.filter((e) => e.kind === 'VOTE').length);
  });

  it('after a gap in the feed, a vote the full read has not read again has no value before', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    chain.vote(E(1), V(1), 7); // never read: the feed loses it
    chain.goneBelow = chain.height + 1;
    const gone = await index.run({ budgetMs: BIG });
    expect(gone.restartedFull).toBe('feed_gone');
    expect(db.state).toMatchObject({ trustFrom: 2, fullPhase: 'groups' });
    chain.vote(E(1), V(1), 8);
    // The feed first: the full read waits for it, then reads everything.
    await index.run({ budgetMs: BIG });
    expect(db.state.fullPhase).toBeNull();
    chain.vote(E(1), V(1), 9);
    await index.run({ budgetMs: BIG });
    const [gap, ...votes] = db.events;
    expect(gap).toMatchObject({
      kind: 'GAP',
      origin: 'SYSTEM',
      height: gone.height,
      data: { from: gone.feedFrom, to: gone.height }
    });
    expect(votes.map((e) => [e.data.oldValue, e.data.newValue])).toEqual([
      [null, '8'],
      ['8', '9']
    ]);
  });

  it('a vote whose record the node could not decode has no value before, until it is read again', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    // The index reads the entry's votes again only once the feed is at the
    // run's height; till then the vote's value is unknown.
    chain.vote(E(1), V(1), 7, true);
    chain.tick(1000);
    chain.tick(1000);
    chain.vote(E(1), V(1), 8);
    const report = await index.run({ budgetMs: BIG });
    expect(report.feedBatches).toBe(2);
    expect(db.events.map((e) => [e.data.oldValue, e.data.newValue])).toEqual([
      [null, '8']
    ]);
  });

  it('after a gap, a vote the full read has been past and did not see was not there', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    chain.vote(E(1), V(2), 0); // never read: the feed loses it
    chain.goneBelow = chain.height + 1;
    await index.run({ budgetMs: BIG });
    expect(db.state.trustFrom).toBe(2);
    chain.callMs = 10;
    for (
      let runs = 0;
      runs < 100 && !fullReadCovers(db.state, D1, E(1));
      runs++
    ) {
      await index.run({ budgetMs: 45 });
    }
    // Past D1, before the sweep: V2's old row is still there, unseen.
    expect(db.state.fullPhase).not.toBeNull();
    expect(
      db.rows('votes').some((v) => v.voter === V(2) && v.entry_id === E(1))
    ).toBe(true);
    chain.vote(E(1), V(2), 4);
    chain.callMs = 0;
    await index.run({ budgetMs: BIG });
    expect(
      db.events
        .filter((e) => e.kind === 'VOTE')
        .map((e) => [e.data.oldValue, e.data.newValue])
    ).toEqual([['0', '4']]);
  });

  it('a full read that takes over from a checking one goes on checking', async () => {
    const { db, index } = indexOf(chain, clock);
    chain.callMs = 10;
    await index.run({ budgetMs: 45 });
    expect(db.state).toMatchObject({ generation: 1, trustFrom: 1 });
    expect(db.state.fullPhase).not.toBeNull();
    // A version that doesn't know the phase starts the full read again.
    db.state = { ...db.state, fullPhase: 'mystery' };
    chain.callMs = 0;
    await index.run({ budgetMs: BIG });
    expect(db.state).toMatchObject({ generation: 2, trustFrom: 2 });
    // A daily full read after a complete one checks nothing again.
    await index.run({ budgetMs: BIG });
    expect(db.state.fullPhase).toBeNull();
    chain.tick(1000);
    clock.t += 25 * 3600_000;
    await index.run({ budgetMs: BIG });
    expect(db.state).toMatchObject({ generation: 3, trustFrom: 2 });
  });

  it('reads a full read at the feed height while the feed trails the head', async () => {
    const trailing = aWorld(clock, (c) => new FeedOneBehind(c));
    const { db, index } = indexOf(trailing, clock);
    await index.run({ budgetMs: BIG });
    expect(db.state.lastFullAt).not.toBeNull();
    trailing.tick(1000);
    clock.t += 25 * 3600_000;
    let runs = 0;
    for (; runs < 10; runs++) {
      trailing.vote(E(1), V(1), runs + 10);
      const report = await index.run({ budgetMs: BIG });
      expect(report.full.waitingForFeed).toBe(false);
      if (db.state.lastFullAt === clock.t) break;
    }
    expect(db.state).toMatchObject({ generation: 2, fullPhase: null });
    expect(runs).toBeLessThan(10);
    // The feed's last block comes with the next one.
    trailing.tick(1000);
    await index.run({ budgetMs: BIG });
    expect(
      db.events.filter((e) => e.kind === 'VOTE').map((e) => e.data.newValue)
    ).toEqual(Array.from({ length: runs + 1 }, (_, i) => String(i + 10)));
  });

  it('waits with a full read while the feed is far behind the head', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    chain.tick(1000);
    clock.t += 25 * 3600_000;
    for (let i = 0; i < 40; i++) chain.vote(E(1), V(1), i + 1);
    chain.callMs = 10;
    const report = await index.run({ budgetMs: 30 });
    expect(report.full.started).toBe(true);
    expect(report.full.waitingForFeed).toBe(true);
    expect(db.state).toMatchObject({ fullPhase: 'groups', fullAfter: null });
    expect(db.state.feedNext).toBeLessThan(chain.height - 32);
  });

  it("tells the scan's cuts from a voter's own VOTE_SET by the scan's records", async () => {
    const stepwise = indexOf(chain, clock);
    const once = indexOf(chain, clock);
    await stepwise.index.run({ budgetMs: BIG });
    await once.index.run({ budgetMs: BIG });
    const steps = [
      () => chain.finishScan(),
      // V2's last vote in D1: VoteScan moves, no scan under way.
      () => chain.vote(E(1), V(2), 0),
      // A reduction of V1 that starts and ends in the block: E1 cut to
      // nothing, E2 moved into its place in V1's list.
      () =>
        chain.scan([
          { voter: V(1), decisionId: D1, cuts: [{ entryId: E(1), value: 0 }] }
        ]),
      // V3's reduction, under way at the end of the block, then ending.
      () =>
        chain.scan(
          [
            {
              voter: V(3),
              decisionId: D1,
              cuts: [{ entryId: E(3), value: 1 }]
            }
          ],
          true
        ),
      () => chain.endReduction([{ entryId: E(3), value: 0 }]),
      () => chain.vote(E(3), V(1), 4),
      // V1 takes E2 back: E3 moves into its place; no scan record.
      () => chain.vote(E(2), V(1), 0),
      // V1's last vote, while the scan is under way.
      () => chain.vote(E(3), V(1), 0),
      () => chain.finishScan(),
      () => chain.vote(E(1), V(1), 3),
      () => chain.vote(E(1), V(1), 0)
    ];
    for (const step of steps) {
      step();
      await stepwise.index.run({ budgetMs: BIG });
    }
    await once.index.run({ budgetMs: BIG });
    const votes = stepwise.db.events.filter((e) => e.kind === 'VOTE');
    expect(
      votes.map((e) => [
        e.entryId,
        e.actor,
        e.data.oldValue,
        e.data.newValue,
        e.origin
      ])
    ).toEqual([
      [E(1), V(2), '3', '0', 'OPERATION'],
      [E(1), V(1), '5', '0', 'AMBIGUOUS'],
      [E(3), V(3), '2', '1', 'SCAN'],
      // V3's reduction ended in this block's scan: V3's own VOTE_SET to 0
      // after it would leave the same records.
      [E(3), V(3), '1', '0', 'AMBIGUOUS'],
      [E(3), V(1), '0', '4', 'OPERATION'],
      [E(2), V(1), '1', '0', 'OPERATION'],
      [E(3), V(1), '4', '0', 'AMBIGUOUS'],
      [E(1), V(1), '0', '3', 'OPERATION'],
      [E(1), V(1), '3', '0', 'OPERATION']
    ]);
    expect(once.db.events).toEqual(stepwise.db.events);
  });

  it('logs no event for a vote that only moved in its voter list, while a rebuild checks every row', async () => {
    const first = indexOf(chain, clock);
    await first.index.run({ budgetMs: BIG });
    const rebuilt = indexOf(chain, clock);
    chain.callMs = 10;
    await rebuilt.index.run({ budgetMs: 45 });
    expect(rebuilt.db.state.fullPhase).not.toBeNull();
    // V1's votes are E1 then E2: taking E1 back moves E2 into its place.
    chain.vote(E(1), V(1), 0);
    await rebuilt.index.run({ budgetMs: 45 });
    chain.callMs = 0;
    await first.index.run({ budgetMs: BIG });
    await rebuilt.index.run({ budgetMs: BIG });
    const moved = (events: ChainEvent[]) =>
      events.map((e) => [e.kind, e.entryId, e.actor, e.data.newValue]);
    expect(moved(first.db.events)).toEqual([['VOTE', E(1), V(1), '0']]);
    expect(moved(rebuilt.db.events)).toEqual(moved(first.db.events));
  });

  it('keeps a vote it could not decode unknown across runs that keep their deadline, and reads it at the feed height', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    chain.vote(E(1), V(2), 6, true);
    for (let i = 0; i < 40; i++) chain.vote(E(2), V(1), i + 2);
    chain.vote(E(1), V(2), 7);
    chain.callMs = 10;
    const start = clock.t;
    await index.run({ budgetMs: 45 });
    expect(clock.t - start).toBeLessThan(10 * 45);
    // More than 32 blocks behind the head: the entry waits, in the state.
    expect(db.state.voteRereads).toEqual({
      entries: [E(1)],
      votes: [`${D1}:${E(1)}:${V(2)}`]
    });
    let runs = 0;
    for (; runs < 100 && db.state.feedNext! <= chain.height; runs++) {
      await index.run({ budgetMs: 45 });
    }
    expect(runs).toBeGreaterThan(3);
    expect(db.state.voteRereads).toEqual({ entries: [], votes: [] });
    expect(
      db.rows('votes').find((v) => v.voter === V(2) && v.entry_id === E(1))
        ?.value
    ).toBe('7');
    // V2's later vote: before it, 6 (read again at the feed's height) or
    // unknown (not read yet), never V2's value from before the record.
    const later = db.events.filter(
      (e) => e.actor === V(2) && e.entryId === E(1)
    );
    expect(later.map((e) => e.data.newValue)).toEqual(['7']);
    expect(['6', null]).toContain(later[0].data.oldValue);
  });

  it('reads votes the node could not decode at the feed height, keeping them in the state till then', async () => {
    const clean = indexOf(chain, clock);
    const failing = indexOf(chain, clock);
    await clean.index.run({ budgetMs: BIG });
    await failing.index.run({ budgetMs: BIG });
    chain.vote(E(1), V(2), 6, true);
    chain.tick(1000);
    chain.tick(1000);
    chain.vote(E(1), V(1), 0); // the next page
    chain.failOn = 'entryVotes';
    await expect(failing.index.run({ budgetMs: BIG })).rejects.toThrow(
      'entryVotes failed'
    );
    // The feed is applied; the entry's votes wait to be read, in the state.
    expect(failing.db.state.feedNext).toBe(chain.height + 1);
    expect(failing.db.state.voteRereads).toEqual({
      entries: [E(1)],
      votes: [`${D1}:${E(1)}:${V(2)}`]
    });
    expect(
      (await failing.db.readEvents(null, 10)).events.map((e) => e.actor)
    ).toEqual([V(1)]);
    chain.failOn = null;
    await failing.index.run({ budgetMs: BIG });
    await clean.index.run({ budgetMs: BIG });
    expect(failing.db.state.voteRereads).toEqual({ entries: [], votes: [] });
    expect(
      failing.db.events.map((e) => [
        e.actor,
        e.data.oldValue,
        e.data.newValue,
        e.origin
      ])
    ).toEqual([[V(1), '5', '0', 'OPERATION']]);
    expect(failing.db.events).toEqual(clean.db.events);
    expect(failing.db.rows('votes')).toEqual(clean.db.rows('votes'));
    expect(failing.db.rows('votes').find((v) => v.voter === V(2))?.value).toBe(
      '6'
    );
  });

  it("reads a wave's roles, polls and REP at the run height in a full read at the feed's height", async () => {
    const trailing = aWorld(clock, (c) => new FeedOneBehind(c));
    const { db, index } = indexOf(trailing, clock);
    await index.run({ budgetMs: BIG });
    trailing.tick(1000);
    clock.t += 25 * 3600_000;
    // The feed applies the first grant and reads W1's roles at the head,
    // which holds the second already; the full read then reads W1 at the
    // feed's height, a block below.
    trailing.putRole(W1, V(4));
    trailing.putRole(W1, V(5));
    const report = await index.run({ budgetMs: BIG });
    expect(report.full.completed).toBe(true);
    expect(
      db
        .rows('roles')
        .filter((r) => r.wave_id === W1)
        .map((r) => String(r.principal_id))
        .sort(compareCodeUnits)
    ).toEqual([V(4), V(5)]);
  });

  it('reads a vote it could not decode at the feed height while the feed trails the head', async () => {
    const trailing = aWorld(clock, (c) => new FeedOneBehind(c));
    const { db, index } = indexOf(trailing, clock);
    await index.run({ budgetMs: BIG });
    trailing.vote(E(1), V(2), 6, true);
    trailing.vote(E(1), V(1), 7);
    for (let run = 0; run < 3; run++) {
      trailing.tick(1000);
      await index.run({ budgetMs: BIG });
    }
    expect(db.state.feedNext).toBe(trailing.height);
    expect(db.state.voteRereads).toEqual({ entries: [], votes: [] });
    expect(
      db.rows('votes').find((v) => v.voter === V(2) && v.entry_id === E(1))
        ?.value
    ).toBe('6');
    expect(
      (await db.readEvents(null, 100)).events.map((e) => [
        e.actor,
        e.data.oldValue,
        e.data.newValue
      ])
    ).toEqual([[V(1), '5', '7']]);
  });

  it("refuses a cursor of another network's log", async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    chain.vote(E(1), V(1), 1);
    await index.run({ budgetMs: BIG });
    const page = await db.readEvents(null, 5);
    expect(page.next).toBe(`${eventCursor(page.events[0])}@net-1`);
    const fresh = new FakeChain(clock);
    fresh.network = 'net-2';
    fresh.height = 50;
    fresh.putWave(id('aa'));
    await new WavesChainIndex(fresh, db.asDb(), clock.now).run({
      budgetMs: BIG
    });
    await expect(db.readEvents(page.next, 5)).rejects.toThrow(EventCursorError);
    expect(await db.readEvents(null, 5)).toMatchObject({
      events: [],
      network: 'net-2'
    });
  });
});

describe('deriveEvents', () => {
  const block = (height: number, records: Record<string, unknown>[]) => ({
    height,
    slot: height,
    root: id(0),
    time: 1000 * height,
    records: records.map((r) => ({
      name: 'r',
      key: '0x',
      value: r.valueFields === null ? null : '0x01',
      ...r
    })) as any
  });
  const activeEntry = (entryId: string, total: string) => ({
    family: '0x0603',
    keyFields: { entryId },
    valueFields: {
      decisionId: D1,
      author: id('a1'),
      status: 1,
      origin: 1,
      total,
      createdMs: '1'
    }
  });
  const deleted = (voter: string, entryId: string) => ({
    family: '0x0607',
    keyFields: { voter, decisionId: D1, entryId },
    valueFields: null
  });
  const reduce = (voter: string | null) => ({
    family: '0x0611',
    keyFields: {},
    valueFields: voter ? { voter, decisionId: D1, phase: 2, next: 3 } : null
  });
  const scanRecord = (scanning: number, finishedDay: number) => ({
    family: '0x0612',
    keyFields: {},
    valueFields: { voters: 3, scanDay: 0, scanning, scanNext: 0, finishedDay }
  });
  const withVote = (value: string, updatedHeight = 3) => {
    const c = emptyEventContext();
    c.votes.set(`${D1}:${E(1)}:${V(1)}`, {
      value,
      updatedHeight,
      generation: 1
    });
    return c;
  };
  const origins = (
    records: Record<string, unknown>[],
    scan = UNKNOWN_SCAN,
    context = withVote('5')
  ) =>
    deriveEvents([block(10, records)], 0, context, TRUST_ALL, {
      scan,
      unknownVotes: new Set()
    }).events.map((e) => e.origin);

  it("tells a scan's cut to nothing from a VOTE_SET to 0 by the scan's records", () => {
    const vote = [activeEntry(E(1), '0'), deleted(V(1), E(1))];
    // No scan record: no scan worked in the block.
    expect(origins(vote)).toEqual(['OPERATION']);
    // The voter's reduction under way at the end of the block, or of the
    // one before.
    expect(origins([...vote, reduce(V(1))])).toEqual(['SCAN']);
    expect(
      origins(vote, { scanning: 1, finishedDay: 4, reducing: `${V(1)}:${D1}` })
    ).toEqual(['SCAN']);
    // A reduction ended in the block, or another one is under way: the
    // voter's may have started and ended in it.
    expect(origins([...vote, reduce(null)])).toEqual(['AMBIGUOUS']);
    expect(origins([...vote, reduce(V(2))])).toEqual(['AMBIGUOUS']);
    // VoteScan written, the scan known idle before and after: a VOTE_SET.
    const idle = { scanning: 0, finishedDay: 4, reducing: null };
    expect(origins([...vote, scanRecord(0, 4)], idle)).toEqual(['OPERATION']);
    // Finished in this block, under way, or not seen yet: can't tell.
    expect(origins([...vote, scanRecord(0, 5)], idle)).toEqual(['AMBIGUOUS']);
    expect(origins([...vote, scanRecord(1, 4)], idle)).toEqual(['AMBIGUOUS']);
    expect(origins([...vote, scanRecord(0, 4)])).toEqual(['AMBIGUOUS']);
  });

  it('carries the scan from block to block and out of the batch; a reduction that ends in the block proves nothing', () => {
    const derived = deriveEvents(
      [
        block(9, [scanRecord(1, 4), reduce(V(1))]),
        block(10, [activeEntry(E(1), '0'), deleted(V(1), E(1)), reduce(null)])
      ],
      0,
      withVote('5'),
      TRUST_ALL
    );
    expect(derived.events.map((e) => e.origin)).toEqual(['AMBIGUOUS']);
    expect(derived.carry.scan).toEqual({
      scanning: 1,
      finishedDay: 4,
      reducing: null
    });
  });

  it('a vote deleted in a decision no longer PUBLISHED was released', () => {
    const vote = [activeEntry(E(1), '5'), deleted(V(1), E(1))];
    const ended = (statusHeight: number) => {
      const c = withVote('5');
      c.decisions.set(D1, { legacyId: null, status: 'ended', statusHeight });
      return c;
    };
    expect(origins(vote, UNKNOWN_SCAN, ended(9))).toEqual(['RELEASE']);
    // Read at or after the block: the decision may have ended after it.
    expect(origins(vote, UNKNOWN_SCAN, ended(10))).toEqual(['OPERATION']);
    const closing = { ...activeEntry(E(1), '5') };
    expect(
      origins([
        closing,
        deleted(V(1), E(1)),
        {
          family: '0x0601',
          keyFields: { decisionId: D1 },
          valueFields: { waveId: W1, status: 3 }
        }
      ])
    ).toEqual(['RELEASE']);
  });

  it('logs no event for a vote that only moved in its list, trusted or not', () => {
    const moved = block(10, [
      {
        family: '0x0607',
        keyFields: { voter: V(1), decisionId: D1, entryId: E(1) },
        valueFields: { value: '5', updatedHeight: '3', index: 0 }
      }
    ]);
    const checking = {
      complete: false,
      generation: 2,
      trustFrom: 2,
      covers: () => false
    };
    expect(deriveEvents([moved], 0, withVote('5'), checking).events).toEqual(
      []
    );
    // Nothing stored that tells: a record older than its block is a move,
    // unless the voter's reduction was under way.
    expect(
      deriveEvents([moved], 0, emptyEventContext(), checking).events
    ).toEqual([]);
    expect(
      deriveEvents([moved], 0, emptyEventContext(), checking, {
        scan: { scanning: 1, finishedDay: 0, reducing: `${V(1)}:${D1}` },
        unknownVotes: new Set()
      }).events.map((e) => [e.origin, e.data.oldValue])
    ).toEqual([['SCAN', null]]);
    // While the voter's reduction is under way, its cut to nothing moves
    // the voter's last vote: the stored value and updatedHeight say so.
    expect(
      deriveEvents([moved], 0, withVote('5'), checking, {
        scan: { scanning: 1, finishedDay: 0, reducing: `${V(1)}:${D1}` },
        unknownVotes: new Set()
      }).events
    ).toEqual([]);
    // A stale row of the same value but another updatedHeight: the vote
    // was set again since, so the record may be the scan's cut to it.
    expect(
      deriveEvents([moved], 0, withVote('5', 2), checking, {
        scan: { scanning: 1, finishedDay: 0, reducing: `${V(1)}:${D1}` },
        unknownVotes: new Set()
      }).events.map((e) => [e.origin, e.data.oldValue])
    ).toEqual([['SCAN', null]]);
  });

  it('a vote stored at or after its block has no value before', () => {
    const set = block(10, [
      {
        family: '0x0607',
        keyFields: { voter: V(1), decisionId: D1, entryId: E(1) },
        valueFields: { value: '7', updatedHeight: '10', index: 0 }
      },
      activeEntry(E(1), '7')
    ]);
    const old = (updatedHeight: number) =>
      deriveEvents([set], 0, withVote('5', updatedHeight), TRUST_ALL).events[0]
        .data.oldValue;
    expect(old(9)).toBe('5');
    expect(old(10)).toBeNull();
  });

  it('a vote the run could not decode before has no value before; one decoded after has', () => {
    const vote = (h: number, value: string | null) =>
      block(h, [
        {
          family: '0x0607',
          keyFields: { voter: V(1), decisionId: D1, entryId: E(1) },
          valueFields:
            value === null
              ? undefined
              : { value, updatedHeight: String(h), index: 0 }
        }
      ]);
    const derived = deriveEvents([vote(10, '7')], 0, withVote('5'), TRUST_ALL, {
      scan: UNKNOWN_SCAN,
      unknownVotes: new Set([`${D1}:${E(1)}:${V(1)}`])
    });
    expect(derived.events[0].data.oldValue).toBeNull();
    expect(derived.carry.unknownVotes.size).toBe(0);
    const undecoded = deriveEvents(
      [vote(11, null)],
      0,
      withVote('5'),
      TRUST_ALL
    );
    expect(undecoded.events).toEqual([]);
    expect(Array.from(undecoded.carry.unknownVotes)).toEqual([
      `${D1}:${E(1)}:${V(1)}`
    ]);
  });

  it('takes a ballot before from the batch only when it is the version just before', () => {
    const ballot = (h: number, selection: number, version: number) =>
      block(h, [
        {
          family: '0x060c',
          keyFields: { pollId: P1, cid: C(1) },
          valueFields: { selection, version }
        }
      ]);
    const { events } = deriveEvents(
      [ballot(5, 0b001, 1), ballot(6, 0b100, 3), ballot(7, 0b010, 4)],
      0,
      emptyEventContext(),
      TRUST_ALL
    );
    expect(events.map((e) => [e.height, e.data.oldChoices])).toEqual([
      [5, []],
      [6, null],
      [7, [2]]
    ]);
  });

  const vote = (value: string | null, updatedHeight = 5) => ({
    family: '0x0607',
    keyFields: { voter: V(1), decisionId: D1, entryId: E(1) },
    valueFields: value === null ? null : { value, updatedHeight, index: 0 }
  });

  it('carries a vote through a batch, and says unknown after a record it could not decode', () => {
    const undecodable = { ...vote('9'), valueFields: undefined };
    const { events } = deriveEvents(
      [
        block(5, [vote('3', 5)]),
        block(6, [vote('4', 6)]),
        block(7, [undecodable]),
        block(8, [vote('2', 8)])
      ],
      0,
      emptyEventContext(),
      TRUST_ALL
    );
    expect(events.map((e) => [e.height, e.data.oldValue])).toEqual([
      [5, '0'],
      [6, '3'],
      [8, null]
    ]);
  });

  it('logs only the blocks at or above where the log stands', () => {
    const { events } = deriveEvents(
      [block(5, [vote('3', 5)]), block(6, [vote('4', 6)])],
      6,
      emptyEventContext(),
      TRUST_ALL
    );
    expect(events.map((e) => [e.height, e.seq, e.data.oldValue])).toEqual([
      [6, 0, '3']
    ]);
  });

  it('an entry created and withdrawn in one block is two events', () => {
    const { events } = deriveEvents(
      [
        block(5, [
          {
            family: '0x0603',
            keyFields: { entryId: E(1) },
            valueFields: {
              decisionId: D1,
              author: V(2),
              status: 3,
              origin: 1,
              total: '0',
              createdMs: '5000'
            }
          }
        ])
      ],
      0,
      emptyEventContext(),
      TRUST_ALL
    );
    expect(events.map((e) => [e.seq, e.kind, e.data.reason])).toEqual([
      [0, 'ENTRY_CREATED', undefined],
      [1, 'ENTRY_RELEASED', 'WITHDRAWN']
    ]);
  });

  it('a ballot whose last logged version is not the one before has no old choices', () => {
    const context = emptyEventContext();
    context.ballots.set(`${P1}:${C(1)}`, { selection: 1, version: 1 });
    const ballot = (version: number) =>
      block(5, [
        {
          family: '0x060c',
          keyFields: { pollId: P1, cid: C(1) },
          valueFields: { selection: 4, version }
        }
      ]);
    const old = (version: number) =>
      deriveEvents([ballot(version)], 0, context, TRUST_ALL).events[0].data
        .oldChoices;
    expect(old(2)).toEqual([0]);
    expect(old(3)).toBeNull();
  });

  it('takes a definition, a policy or a result only in the block that made it', () => {
    const records = (made: number, settled: number) => [
      {
        family: '0x0402',
        keyFields: { groupId: G1, version: 1 },
        valueFields: { activationHeight: String(made), includes: [] }
      },
      {
        family: '0x0502',
        keyFields: { waveId: W1, version: 2 },
        valueFields: { activationHeight: String(made) }
      },
      {
        family: '0x060a',
        keyFields: { id: D1, D: '7' },
        valueFields: { stage: 3, status: 2, settledHeight: String(settled) }
      }
    ];
    const kinds = (made: number, settled: number) =>
      deriveEvents(
        [block(5, records(made, settled))],
        0,
        emptyEventContext(),
        TRUST_ALL
      ).events.map((e) => e.kind);
    expect(kinds(5, 5)).toEqual([
      'GROUP_CREATED',
      'WAVE_POLICY_REPLACED',
      'RESULT_FINAL'
    ]);
    expect(kinds(4, 4)).toEqual([]);
  });

  it('reads cursors and choices', () => {
    expect(parseEventCursor(null)).toBeNull();
    expect(parseEventCursor('12:3')).toEqual({
      height: 12,
      seq: 3,
      network: null
    });
    expect(parseEventCursor('12:3@net-1')).toEqual({
      height: 12,
      seq: 3,
      network: 'net-1'
    });
    expect(eventCursor({ height: 12, seq: 3 }, 'net-1')).toBe('12:3@net-1');
    expect(() => parseEventCursor('12')).toThrow('height:seq');
    expect(() => parseEventCursor('x:1')).toThrow('height:seq');
    expect(choicesOf(0b1011)).toEqual([0, 1, 3]);
    expect(choicesOf(0)).toEqual([]);
  });

  it('knows where a full read under way has read votes', () => {
    const at = (fullPhase: string | null, fullAfter: string | null) =>
      [
        [D1, E(1)],
        [D1, E(3)],
        [D2, E(1)]
      ].map(([d, e]) => fullReadCovers({ fullPhase, fullAfter }, d, e));
    expect(at('waves', null)).toEqual([false, false, false]);
    expect(at('decisions', null)).toEqual([false, false, false]);
    expect(at('decisions', `${D1}:`)).toEqual([false, false, false]);
    expect(at('decisions', `${D1}:${E(2)}`)).toEqual([true, false, false]);
    expect(at('decisions', D1)).toEqual([true, true, false]);
    expect(at('decisions', `${D2}:`)).toEqual([true, true, false]);
    expect(at('sweep', null)).toEqual([true, true, true]);
  });
});
