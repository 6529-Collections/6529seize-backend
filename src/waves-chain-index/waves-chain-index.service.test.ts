import {
  FakeChain,
  FakeClock,
  FakeIndexDb,
  id
} from '@/tests/fixtures/waves-chain-index.fixture';
import { IndexTableName } from './waves-chain-index.db';
import { WavesChainIndex } from './waves-chain-index.service';

const TABLES: IndexTableName[] = [
  'groups',
  'waves',
  'roles',
  'polls',
  'waveRep',
  'decisions',
  'entries',
  'votes',
  'results',
  'leaderboards'
];

const G1 = id('91');
const G2 = id('92');
const W1 = id('a1');
const W2 = id('a2');
const P1 = id('b1');
const D1 = id('d1');
const D2 = id('d2');
const E = (n: number) => id(`e${n}`);
const V = (n: number) => id(`f${n}`);

/** Two waves, a live counted decision with three entries, an ended one. */
function aWorld(clock: FakeClock): FakeChain {
  const chain = new FakeChain(clock);
  chain.putGroup(G1);
  chain.putGroup(G2, { legacyId: 'ABC-1' });
  chain.putWave(W1, {
    legacyId: '8FE9-W1',
    readGroup: { groupId: G1, version: 0 },
    membersOnly: true
  });
  chain.putWave(W2);
  chain.putRole(W1, V(1));
  chain.rate(W1, V(2), 7);
  chain.putPoll(P1, W1);
  chain.putDecision(D1, W1, { counted: true, nextResultTime: 1 });
  chain.putDecision(D2, W2, { status: 'ended' });
  chain.putEntry(E(1), D1);
  chain.putEntry(E(2), D1);
  chain.putEntry(E(3), D1);
  chain.putEntry(E(4), D2, { status: 'winner' });
  chain.vote(E(1), V(1), 5);
  chain.vote(E(1), V(2), 3);
  chain.vote(E(2), V(1), 1);
  chain.vote(E(3), V(3), 2);
  chain.vote(E(4), V(1), 9);
  chain.putResult(D2, 1_700_000_000_000);
  return chain;
}

function indexOf(chain: FakeChain, clock: FakeClock) {
  const db = new FakeIndexDb();
  const index = new WavesChainIndex(chain, db.asDb(), clock.now);
  return { db, index };
}

/** A fresh index read whole from the chain as it is now. */
async function freshRows(chain: FakeChain, clock: FakeClock) {
  const callMs = chain.callMs;
  chain.callMs = 0;
  const { db, index } = indexOf(chain, clock);
  await index.run({ budgetMs: 1_000_000 });
  chain.callMs = callMs;
  expect(db.state.fullPhase).toBeNull();
  return Object.fromEntries(TABLES.map((t) => [t, db.rows(t)]));
}

function rowsOf(db: FakeIndexDb) {
  return Object.fromEntries(TABLES.map((t) => [t, db.rows(t)]));
}

describe('WavesChainIndex', () => {
  let clock: FakeClock;
  let chain: FakeChain;

  beforeEach(() => {
    clock = new FakeClock();
    chain = aWorld(clock);
  });

  it('does nothing before the waves import completes', async () => {
    chain.completed = false;
    const { db, index } = indexOf(chain, clock);
    const report = await index.run({ budgetMs: 1_000_000 });
    expect(report).toMatchObject({
      mode: 'skipped',
      skipped: 'import_not_complete'
    });
    expect(db.state.generation).toBe(0);
    expect(chain.calls).toBe(1);
  });

  it('reads everything at one height, then follows the feed from the next', async () => {
    const { db, index } = indexOf(chain, clock);
    const height = chain.height;
    const report = await index.run({ budgetMs: 1_000_000 });
    expect(report.full).toMatchObject({
      generation: 1,
      started: true,
      completed: true,
      phase: null
    });
    expect(db.state).toMatchObject({
      generation: 1,
      fullPhase: null,
      fullFromHeight: height,
      feedNext: height + 1,
      lastFullAt: clock.t,
      lastError: null
    });
    expect(db.rows('waves')).toEqual([
      expect.objectContaining({
        wave_id: W1,
        legacy_id: '8fe9-w1',
        members_only: true,
        read_group_id: G1,
        post_group_id: null,
        admin_group_id: null
      }),
      expect.objectContaining({ wave_id: W2, read_group_id: null })
    ]);
    expect(db.rows('groups').map((g) => g.legacy_id)).toEqual([null, 'abc-1']);
    expect(db.rows('roles')).toEqual([
      expect.objectContaining({
        wave_id: W1,
        role: 'admin',
        principal_id: V(1),
        live: true
      })
    ]);
    expect(db.rows('waveRep')).toEqual([
      expect.objectContaining({
        wave_id: W1,
        rater: V(2),
        category_id: id('c'),
        category_name: 'Cat',
        value: 7
      })
    ]);
    expect(db.rows('polls')).toEqual([
      expect.objectContaining({ poll_id: P1, wave_id: W1, status: 'open' })
    ]);
    expect(
      db.rows('entries').map((e) => [e.entry_id, e.status, e.total])
    ).toEqual([
      [E(1), 'active', '8'],
      [E(2), 'active', '1'],
      [E(3), 'active', '2'],
      [E(4), 'winner', '9']
    ]);
    expect(db.rows('votes').map((v) => [v.entry_id, v.voter, v.value])).toEqual(
      [
        [E(1), V(1), '5'],
        [E(1), V(2), '3'],
        [E(2), V(1), '1'],
        [E(3), V(3), '2'],
        [E(4), V(1), '9']
      ]
    );
    expect(db.rows('results')).toEqual([
      expect.objectContaining({
        decision_id: D2,
        result_time: 1_700_000_000_000,
        status: 'decided',
        stage: 'final'
      })
    ]);
    const board = db.rows('leaderboards').find((l) => l.decision_id === D1);
    expect(
      (board?.data as { rows: { entryId: string }[] }).rows.map(
        (r) => r.entryId
      )
    ).toEqual([E(1), E(3), E(2)]);
    // Every row is stamped with the run's height and the full read.
    for (const table of TABLES) {
      for (const row of db.rows(table, true)) {
        expect(row).toMatchObject({ height, generation: 1 });
      }
    }
  });

  it('spreads a full read over runs, stopping inside a decision, and ends where one run does', async () => {
    chain.callMs = 10;
    const { db, index } = indexOf(chain, clock);
    const cursors: (string | null)[] = [];
    for (let run = 0; run < 100 && db.state.lastFullAt === null; run++) {
      await index.run({ budgetMs: 25 });
      cursors.push(db.state.fullAfter);
    }
    expect(db.state.lastFullAt).not.toBeNull();
    expect(cursors.some((c) => c?.includes(':'))).toBe(true);
    expect(cursors.length).toBeGreaterThan(5);
    // One more run at a standing clock: what moves with time is read at the
    // same time as the fresh read's.
    chain.callMs = 0;
    await index.run({ budgetMs: 25 });
    expect(rowsOf(db)).toEqual(await freshRows(chain, clock));
  });

  it('follows the feed: every change ends as a fresh read of the chain would have it', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: 1_000_000 });
    const W3 = id('a3');
    const E5 = id('e5');
    chain.vote(E(1), V(1), 6); // changed
    chain.vote(E(2), V(1), 0); // deleted
    chain.vote(E(3), V(4), 4); // new
    chain.putEntry(E(3), D1, { status: 'withdrawn' });
    chain.putEntry(E5, D1);
    chain.vote(E5, V(2), 1);
    chain.putWave(W3, { postGroup: { groupId: G2, version: 1 } });
    chain.putRole(W3, V(3), { role: 'moderator' });
    chain.rate(W1, V(2), 0); // rating removed
    chain.rate(W2, V(3), -2);
    chain.putPoll(id('b2'), W2, { status: 'closed' });
    chain.putGroup(G1, { version: 2 });
    chain.putResult(D1, 1, { status: 'counting', stage: 'scoring' });
    chain.putDecision(D1, W1, { counted: true, due: true, nextResultTime: 1 });
    const report = await index.run({ budgetMs: 1_000_000 });
    expect(report.feedPages).toBeGreaterThan(1);
    expect(report.votes).toBe(4);
    expect(db.state.feedNext).toBe(chain.height + 1);
    expect(db.rows('votes').map((v) => [v.entry_id, v.voter, v.value])).toEqual(
      [
        [E(1), V(1), '6'],
        [E(1), V(2), '3'],
        [E(3), V(3), '2'],
        [E(3), V(4), '4'],
        [E5, V(2), '1'],
        [E(4), V(1), '9']
      ]
    );
    expect(
      db.rows('decisions').find((d) => d.decision_id === D1)
    ).toMatchObject({
      due: true
    });
    expect(rowsOf(db)).toEqual(await freshRows(chain, clock));
  });

  it('reads only up to the run height when the feed answers further', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: 1_000_000 });
    chain.vote(E(1), V(1), 10);
    chain.vote(E(2), V(1), 20);
    chain.lag = 1; // the feed holds the second vote, the finalized head not yet
    const height = chain.height - 1;
    await index.run({ budgetMs: 1_000_000 });
    expect(db.state.feedNext).toBe(height + 1);
    const values = () =>
      db
        .rows('votes')
        .filter((v) => v.voter === V(1))
        .map((v) => v.value);
    expect(values()).toEqual(['10', '1', '9']);
    chain.lag = 0;
    await index.run({ budgetMs: 1_000_000 });
    expect(values()).toEqual(['10', '20', '9']);
    expect(rowsOf(db)).toEqual(await freshRows(chain, clock));
  });

  it('reads everything again when the feed no longer holds its cursor, and removes what is gone', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: 1_000_000 });
    // Changes the index never sees in the feed.
    chain.votes.get(E(1))!.delete(V(2));
    chain.roles.set(W1, []);
    chain.entries.delete(E(3));
    chain.votes.delete(E(3));
    chain.putWave(id('a4'));
    chain.goneBelow = chain.height + 1;
    const report = await index.run({ budgetMs: 1_000_000 });
    expect(report.restartedFull).toBe('feed_gone');
    expect(db.state).toMatchObject({
      generation: 2,
      fullPhase: 'groups',
      feedNext: chain.height + 1
    });
    const done = await index.run({ budgetMs: 1_000_000 });
    expect(done.full.completed).toBe(true);
    // The wave's roles and the decision's entries were replaced whole; the
    // removed entry's vote went with the sweep.
    expect(done.full.swept).toMatchObject({ roles: 0, entries: 0, votes: 1 });
    expect(rowsOf(db)).toEqual(await freshRows(chain, clock));
  });

  it('runs a full read again after a day', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: 1_000_000 });
    chain.rep.set(W1, []); // never in the feed
    clock.t += 23 * 3600_000;
    expect((await index.run({ budgetMs: 1_000_000 })).full.started).toBe(false);
    expect(db.rows('waveRep')).toHaveLength(1);
    clock.t += 2 * 3600_000;
    const report = await index.run({ budgetMs: 1_000_000 });
    expect(report.full).toMatchObject({
      started: true,
      completed: true,
      generation: 2
    });
    expect(db.rows('waveRep')).toHaveLength(0);
    expect(db.state.lastFullAt).toBe(clock.t);
  });

  it('reads again what moves with time: live decisions and their boards, open polls, expired roles', async () => {
    chain.putRole(W2, V(5), { expiresAt: clock.t + 1000 });
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: 1_000_000 });
    const readAt = () =>
      (
        db.rows('decisions').find((d) => d.decision_id === D1)?.data as {
          readAt: number;
        }
      ).readAt;
    const scoredAt = () =>
      (
        db.rows('leaderboards').find((l) => l.decision_id === D1)?.data as {
          scoredAt: number;
        }
      ).scoredAt;
    const first = readAt();
    clock.t += 60_000;
    // No feed records: the chain's answers moved with time alone.
    chain.polls.set(P1, { ...chain.polls.get(P1)!, status: 'closed' });
    chain.roles.set(W2, [{ ...chain.roles.get(W2)![0], live: false }]);
    const report = await index.run({ budgetMs: 1_000_000 });
    expect(report.timeDependent).toBe(3); // D1, P1, W2's roles
    expect(readAt()).toBe(first + 60_000);
    expect(scoredAt()).toBe(clock.t);
    expect(db.rows('polls')[0]).toMatchObject({ status: 'closed' });
    expect(db.rows('roles').find((r) => r.wave_id === W2)).toMatchObject({
      live: false
    });
    // Nothing left to move: the next run reads D1 only.
    expect((await index.run({ budgetMs: 1_000_000 })).timeDependent).toBe(1);
  });

  it('skips a run when the gateway is behind the index', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: 1_000_000 });
    chain.vote(E(1), V(1), 1);
    await index.run({ budgetMs: 1_000_000 });
    chain.lag = 2;
    const report = await index.run({ budgetMs: 1_000_000 });
    expect(report).toMatchObject({
      mode: 'skipped',
      skipped: 'gateway_behind'
    });
    expect(db.state.feedNext).toBe(chain.height + 1);
  });

  it('saves the error and carries on at the next run', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: 1_000_000 });
    chain.vote(E(1), V(1), 1);
    chain.failOn = 'entry';
    await expect(index.run({ budgetMs: 1_000_000 })).rejects.toThrow(
      'entry failed'
    );
    expect(db.state.lastError).toBe('entry failed');
    const before = db.state.feedNext;
    chain.failOn = null;
    await index.run({ budgetMs: 1_000_000 });
    expect(db.state.lastError).toBeNull();
    expect(db.state.feedNext).toBeGreaterThan(before as number);
    expect(rowsOf(db)).toEqual(await freshRows(chain, clock));
  });
});
