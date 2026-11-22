import {
  FakeChain,
  FakeClock,
  FakeIndexDb,
  id
} from '@/tests/fixtures/waves-chain-index.fixture';
import { ChainObject } from './waves-chain-index.api';
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
  'leaderboards',
  'leaderboardRows'
];

const BIG = 1_000_000;
const G1 = id('91');
const G2 = id('92');
const W1 = id('a1');
const W2 = id('a2');
const P1 = id('b1');
const D1 = id('d1');
const D2 = id('d2');
const D3 = id('d3');
const E = (n: number) => id(`e${n}`);
const V = (n: number) => id(`f${n}`);

/**
 * Two waves; D1 a live counted decision (time-weighted scores), D2 an ended
 * one with a result, D3 a published decision ranked by total.
 */
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
  chain.putDecision(D1, W1, {
    counted: true,
    nextResultTime: clock.t + 3600_000
  });
  chain.putDecision(D2, W2, { status: 'ended' });
  chain.putDecision(D3, W2, { kind: 'approve' });
  chain.putEntry(E(1), D1);
  chain.putEntry(E(2), D1);
  chain.putEntry(E(3), D1);
  chain.putEntry(E(4), D2, { status: 'winner' });
  chain.putEntry(E(6), D3);
  chain.vote(E(1), V(1), 5);
  chain.vote(E(1), V(2), 3);
  chain.vote(E(2), V(1), 1);
  chain.vote(E(3), V(3), 2);
  chain.vote(E(4), V(1), 9);
  chain.vote(E(6), V(2), 4);
  chain.putResult(D2, 1_700_000_000_000);
  return chain;
}

function indexOf(chain: FakeChain, clock: FakeClock) {
  const db = new FakeIndexDb();
  const index = new WavesChainIndex(chain, db.asDb(), clock.now);
  return { db, index };
}

function rowsOf(db: FakeIndexDb) {
  return Object.fromEntries(TABLES.map((t) => [t, db.rows(t)]));
}

/** A fresh index read whole from the chain at its finalized height. */
async function freshRows(chain: FakeChain, clock: FakeClock) {
  const callMs = chain.callMs;
  chain.callMs = 0;
  const { db, index } = indexOf(chain, clock);
  await index.run({ budgetMs: BIG });
  chain.callMs = callMs;
  expect(db.state.fullPhase).toBeNull();
  return rowsOf(db);
}

const dataOf = (row: Record<string, unknown> | undefined) =>
  row?.data as ChainObject;

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
    const report = await index.run({ budgetMs: BIG });
    expect(report).toMatchObject({
      mode: 'skipped',
      skipped: 'import_not_complete'
    });
    expect(db.state.generation).toBe(0);
    expect(chain.calls).toBe(2);
  });

  it('reads everything at one height, then follows the feed from the next', async () => {
    const { db, index } = indexOf(chain, clock);
    const height = chain.height;
    const report = await index.run({ budgetMs: BIG });
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
      readHeight: height,
      network: 'net-1',
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
    expect(dataOf(db.rows('waves')[0]).openPolls).toBe(1);
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
      [E(4), 'winner', '9'],
      [E(6), 'active', '4']
    ]);
    expect(db.rows('votes').map((v) => [v.entry_id, v.voter, v.value])).toEqual(
      [
        [E(1), V(1), '5'],
        [E(1), V(2), '3'],
        [E(2), V(1), '1'],
        [E(3), V(3), '2'],
        [E(4), V(1), '9'],
        [E(6), V(2), '4']
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
    // Boards of published decisions only; one ranked by total keeps no time.
    const boards = db.rows('leaderboards');
    expect(boards.map((b) => b.decision_id)).toEqual([D1, D3]);
    expect(boards[0].scored_at).toBe(chain.blocks.at(-1)!.time);
    expect(
      db
        .rows('leaderboardRows')
        .filter((r) => r.decision_id === D1)
        .sort((a, b) => Number(a.rank) - Number(b.rank))
        .map((r) => [r.rank, r.entry_id])
    ).toEqual([
      [1, E(1)],
      [2, E(3)],
      [3, E(2)]
    ]);
    expect(boards[1].scored_at).toBe(0);
    expect(dataOf(boards[1])).not.toHaveProperty('scoredAt');
    // Every row is stamped with the run's height and the full read.
    for (const table of TABLES) {
      for (const row of db.rows(table, true)) {
        expect(row).toMatchObject({ height, generation: 1 });
      }
    }
  });

  it('spreads a full read over runs while the chain moves, stopping inside a decision', async () => {
    chain.callMs = 10;
    const { db, index } = indexOf(chain, clock);
    const cursors: (string | null)[] = [];
    let run = 0;
    for (; run < 200 && db.state.lastFullAt === null; run++) {
      await index.run({ budgetMs: 45 });
      cursors.push(db.state.fullAfter);
      if (run === 3) chain.vote(E(2), V(4), 6);
      if (run === 6) chain.putEntry(E(7), D1);
      if (run === 9) chain.vote(E(1), V(1), 0);
    }
    expect(db.state.lastFullAt).not.toBeNull();
    expect(cursors.some((c) => c?.startsWith(`${D1}:0x`))).toBe(true);
    expect(run).toBeGreaterThan(5);
    await index.run({ budgetMs: BIG });
    expect(rowsOf(db)).toEqual(await freshRows(chain, clock));
  });

  it('follows the feed: every change ends as a fresh read at the same height has it', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    const W3 = id('a3');
    const E5 = id('e5');
    const P2 = id('b2');
    chain.vote(E(1), V(1), 6); // changed
    chain.vote(E(2), V(1), 0); // deleted
    chain.vote(E(3), V(4), 4); // new
    chain.vote(E(3), V(5), 1, true); // a record the node could not decode
    chain.putEntry(E(3), D1, { status: 'withdrawn' });
    chain.putEntry(E5, D1);
    chain.vote(E5, V(2), 1);
    chain.putWave(W3, { postGroup: { groupId: G2, version: 1 } });
    chain.putRole(W3, V(3), { role: 'moderator' });
    chain.rate(W1, V(2), 0); // rating removed
    chain.rate(W2, V(3), -2);
    chain.putPoll(P2, W2);
    chain.closePoll(P1); // its result is under the poll's id
    chain.putGroup(G1, { version: 2 });
    chain.putResult(D1, 1, { status: 'counting', stage: 'scoring' });
    chain.putDecision(D3, W2, { kind: 'approve', status: 'ended' });
    const report = await index.run({ budgetMs: BIG });
    expect(report.feedBatches).toBeGreaterThan(1);
    expect(db.state.feedNext).toBe(chain.height + 1);
    expect(db.rows('votes').map((v) => [v.entry_id, v.voter, v.value])).toEqual(
      [
        [E(1), V(1), '6'],
        [E(1), V(2), '3'],
        [E(3), V(3), '2'],
        [E(3), V(4), '4'],
        [E(3), V(5), '1'],
        [E5, V(2), '1'],
        [E(4), V(1), '9'],
        [E(6), V(2), '4']
      ]
    );
    expect(db.rows('results').map((r) => r.decision_id)).toEqual([D1, D2]);
    expect(db.rows('polls').find((p) => p.poll_id === P1)).toMatchObject({
      status: 'closed'
    });
    expect(dataOf(db.rows('waves')[0]).openPolls).toBe(0);
    // D3 ended: its board is gone.
    expect(db.rows('leaderboards').map((b) => b.decision_id)).toEqual([D1]);
    expect(
      db.rows('entries').find((e) => e.entry_id === E5)
    ).not.toHaveProperty('data.score');
    expect(rowsOf(db)).toEqual(await freshRows(chain, clock));
  });

  it('reads at the finalized height only, and never below the last run', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    chain.vote(E(1), V(1), 10);
    chain.vote(E(2), V(1), 20);
    chain.lag = 1; // the feed holds the second vote, the finalized head not yet
    const height = chain.height - 1;
    await index.run({ budgetMs: BIG });
    expect(db.state).toMatchObject({
      feedNext: height + 1,
      readHeight: height
    });
    const values = () =>
      db
        .rows('votes')
        .filter((v) => v.voter === V(1))
        .map((v) => v.value);
    expect(values()).toEqual(['10', '1', '9']);
    expect(db.rows('entries').find((e) => e.entry_id === E(2))?.total).toBe(
      '1'
    );
    chain.lag = 0;
    await index.run({ budgetMs: BIG });
    expect(values()).toEqual(['10', '20', '9']);
    expect(rowsOf(db)).toEqual(await freshRows(chain, clock));
    // A node a block behind the last run's.
    chain.lag = 1;
    const before = rowsOf(db);
    const report = await index.run({ budgetMs: BIG });
    expect(report).toMatchObject({
      mode: 'skipped',
      skipped: 'gateway_behind'
    });
    expect(rowsOf(db)).toEqual(before);
  });

  it('asks the feed again before taking a gone answer as final', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    chain.vote(E(1), V(1), 1);
    chain.goneTimes = 2;
    const report = await index.run({ budgetMs: BIG });
    expect(report.restartedFull).toBeNull();
    expect(db.state.generation).toBe(1);
    expect(db.state.feedNext).toBe(chain.height + 1);
  });

  it('reads everything again when the feed no longer holds its cursor, and removes what is gone', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    // Changes the index never sees in the feed.
    chain.live.votes.get(E(1))!.delete(V(2));
    chain.live.roles.set(W1, []);
    chain.live.entries.delete(E(3));
    chain.live.votes.delete(E(3));
    chain.putWave(id('a4'));
    chain.goneBelow = chain.height + 1;
    // Parts done of an old block mean nothing at the new cursor.
    Object.assign(db.state, { feedPart: 1 });
    const report = await index.run({ budgetMs: BIG });
    expect(report.restartedFull).toBe('feed_gone');
    expect(db.state).toMatchObject({
      generation: 2,
      fullPhase: 'groups',
      feedPart: 0,
      feedNext: chain.height + 1
    });
    const done = await index.run({ budgetMs: BIG });
    expect(done.full.completed).toBe(true);
    // Wave roles are replaced whole; entries and votes go with the sweep.
    expect(done.full.swept).toMatchObject({ roles: 0, entries: 1, votes: 2 });
    expect(rowsOf(db)).toEqual(await freshRows(chain, clock));
  });

  it('applies a block too large for one batch in parts, going on across runs', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    // One block that touches 250 groups: three parts of about 100 reads.
    const groups = Array.from({ length: 250 }, (_, i) => id(`9${i + 100}`));
    for (const groupId of groups) {
      chain.live.groups.set(groupId, { groupId, version: 1, origin: 'native' });
    }
    chain.commit(
      groups.map((groupId) => ({ family: '0x0401', keyFields: { groupId } }))
    );
    const big = chain.height;
    chain.vote(E(1), V(1), 2);
    chain.callMs = 10;
    const parts: number[] = [];
    for (let run = 0; run < 10 && db.state.feedNext! <= big; run++) {
      await index.run({ budgetMs: 300 });
      parts.push(db.state.feedPart);
      if (db.state.feedNext! <= big) expect(db.state.feedNext).toBe(big);
    }
    expect(parts).toEqual([1, 2, 0]);
    chain.callMs = 0;
    await index.run({ budgetMs: BIG });
    expect(db.state.feedNext).toBe(chain.height + 1);
    expect(db.rows('groups').length).toBe(252);
    expect(rowsOf(db)).toEqual(await freshRows(chain, clock));
  });

  it('writes only the leaderboard rows that moved', async () => {
    for (let i = 10; i < 30; i++) chain.putEntry(id(`e${i}`), D3);
    for (let i = 10; i < 30; i++) chain.vote(id(`e${i}`), V(3), i * 10);
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    const written = () =>
      db
        .rows('leaderboardRows', true)
        .filter((r) => r.decision_id === D3 && r.height === chain.height)
        .map((r) => r.entry_id);
    expect(
      db.rows('leaderboardRows').filter((r) => r.decision_id === D3)
    ).toHaveLength(21);
    // E12 moves past E13 and E14 (D3 ranks by total): three rows move.
    chain.vote(id('e12'), V(3), 145);
    await index.run({ budgetMs: BIG });
    expect(written().sort()).toEqual([id('e12'), id('e13'), id('e14')]);
    // Its total moves, not its place: one row.
    chain.vote(id('e12'), V(3), 146);
    await index.run({ budgetMs: BIG });
    expect(written()).toEqual([id('e12')]);
    expect(rowsOf(db)).toEqual(await freshRows(chain, clock));
    // A day later the full read keeps the unmoved rows (their generation).
    chain.tick(1000);
    clock.t += 25 * 3600_000;
    const full = await index.run({ budgetMs: BIG });
    expect(full.full.completed).toBe(true);
    expect(written()).toEqual([]);
    expect(rowsOf(db)).toEqual(await freshRows(chain, clock));
  });

  it('runs a full read again after a day', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    chain.live.rep.set(W1, []); // never in the feed
    chain.tick(1000);
    clock.t += 23 * 3600_000;
    expect((await index.run({ budgetMs: BIG })).full.started).toBe(false);
    expect(db.rows('waveRep')).toHaveLength(1);
    clock.t += 2 * 3600_000;
    const report = await index.run({ budgetMs: BIG });
    expect(report.full).toMatchObject({
      started: true,
      completed: true,
      generation: 2
    });
    expect(db.rows('waveRep')).toHaveLength(0);
    expect(db.state.lastFullAt).toBe(clock.t);
  });

  it('reads again what moves with block time: a live counted decision and its board, expired roles', async () => {
    chain.putDecision(D1, W1, {
      counted: true,
      nextResultTime: clock.t + 90_000
    });
    chain.putRole(W2, V(5), { expiresAt: clock.t + 30_000 });
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    const board = (decisionId: string) =>
      db.rows('leaderboards').find((b) => b.decision_id === decisionId);
    const d1 = () => db.rows('decisions').find((d) => d.decision_id === D1);
    expect(d1()).toMatchObject({ due: false });
    const d3Board = board(D3);
    // Blocks with no records: only time moves.
    chain.tick(60_000);
    let report = await index.run({ budgetMs: BIG });
    expect(report.timeDependent).toBe(2); // D1, and W2's roles
    expect(board(D1)?.scored_at).toBe(chain.blocks.at(-1)!.time);
    expect(db.rows('roles').find((r) => r.wave_id === W2)).toMatchObject({
      live: false
    });
    expect(d1()).toMatchObject({ due: false });
    chain.tick(60_000);
    report = await index.run({ budgetMs: BIG });
    expect(report.timeDependent).toBe(1);
    expect(d1()).toMatchObject({ due: true });
    // A board ranked by total does not move with time.
    expect(board(D3)).toEqual(d3Board);
    expect(rowsOf(db)).toEqual(await freshRows(chain, clock));
  });

  it('empties the index for a relaunched chain', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    const fresh = new FakeChain(clock);
    fresh.network = 'net-2';
    fresh.height = 50; // a new chain starts low
    fresh.putWave(id('aa'));
    const relaunched = new WavesChainIndex(fresh, db.asDb(), clock.now);
    const report = await relaunched.run({ budgetMs: BIG });
    expect(report.restartedFull).toBe('network_changed');
    expect(db.rows('waves').map((w) => w.wave_id)).toEqual([id('aa')]);
    expect(db.rows('votes')).toHaveLength(0);
    expect(db.state).toMatchObject({ network: 'net-2', readHeight: 51 });
  });

  it('starts again at a full-read phase it does not know, without emptying anything', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    const before = rowsOf(db);
    db.state = { ...db.state, fullPhase: 'mystery' };
    await index.run({ budgetMs: BIG });
    expect(db.state.fullPhase).toBe('groups');
    expect(rowsOf(db)).toEqual(before);
    await index.run({ budgetMs: BIG });
    expect(db.state.fullPhase).toBeNull();
    expect(rowsOf(db)).toEqual(before);
  });

  it('saves the error and carries on at the next run', async () => {
    const { db, index } = indexOf(chain, clock);
    await index.run({ budgetMs: BIG });
    chain.vote(E(1), V(1), 1);
    chain.failOn = 'entry';
    await expect(index.run({ budgetMs: BIG })).rejects.toThrow('entry failed');
    expect(db.state.lastError).toBe('entry failed');
    const before = db.state.feedNext;
    chain.failOn = null;
    await index.run({ budgetMs: BIG });
    expect(db.state.lastError).toBeNull();
    expect(db.state.feedNext).toBeGreaterThan(before as number);
    expect(rowsOf(db)).toEqual(await freshRows(chain, clock));
  });
});
