import 'reflect-metadata';
import { CHAIN_EVENTS_TABLE } from '@/constants/db-tables';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { EMPTY_INDEX_STATE, WavesChainIndexDb } from './waves-chain-index.db';
import {
  ChainEvent,
  eventCursor,
  EventCursorError,
  gapEvent,
  UNKNOWN_SCAN
} from './waves-chain-index.events';
import {
  decisionRow,
  entryRow,
  groupRow,
  pollRow,
  voteRow,
  waveRow
} from './waves-chain-index.rows';

const id = (n: number | string) => `0x${String(n).padStart(64, '0')}`;
const W = id('a1');
const D = id('d1');
const E1 = id('e1');
const E2 = id('e2');
const P = id('b1');
const G = id('91');
const V1 = id('f1');
const C1 = id('c1');
const C2 = id('c2');
const SCAN = { scanning: 1, finishedDay: 7, reducing: `${V1}:${D}` };

function anEvent(
  height: number,
  seq: number,
  fields: Partial<ChainEvent> = {}
): ChainEvent {
  return {
    height,
    seq,
    blockTime: 1_764_000_000_000 + height * 1000,
    kind: 'VOTE',
    origin: 'OPERATION',
    waveId: W,
    waveLegacyId: 'aaaa-1',
    decisionId: D,
    decisionLegacyId: null,
    entryId: E1,
    entryLegacyId: 'eeee-1',
    pollId: null,
    pollLegacyId: null,
    groupId: null,
    groupLegacyId: null,
    actor: V1,
    data: {
      voter: V1,
      oldValue: '0',
      newValue: '-9223372036854775808',
      entryTotalAfter: '340282366920938463463374607431768211455'
    },
    ...fields
  };
}

const ballot = (height: number, cid: string, selection: number, v: number) =>
  anEvent(height, 0, {
    kind: 'POLL_BALLOT',
    pollId: P,
    entryId: null,
    decisionId: null,
    actor: cid,
    data: { cid, newSelection: selection, version: v }
  });

describeWithSeed('WavesChainIndexDb: the event log', [], () => {
  const db = new WavesChainIndexDb(() => sqlExecutor);
  const stamp = { height: 10, generation: 1 };

  beforeEach(async () => {
    await db.saveState(
      { ...EMPTY_INDEX_STATE, feedNext: 21, network: 'net-1' },
      1
    );
  });

  it('appends events with the height the log reached, and reads them in order after a cursor', async () => {
    const events = [
      anEvent(12, 0),
      anEvent(12, 1, { kind: 'ENTRY_CREATED', entryId: E2, actor: null }),
      anEvent(15, 0, { origin: 'SCAN' }),
      ...Array.from({ length: 30 }, (_, i) =>
        anEvent(20, i, { data: { big: 'x'.repeat(1500), i } })
      )
    ];
    await db.writeEvents(events.slice(0, 3), 16, UNKNOWN_SCAN);
    await db.writeEvents(events.slice(3), 21, SCAN);
    expect(await db.loadState()).toMatchObject({
      eventsNext: 21,
      scanState: SCAN
    });

    const first = await db.readEvents(null, 2);
    expect(first.events).toEqual(events.slice(0, 2));
    expect(first.next).toBe('12:1@net-1');
    expect(first.appliedHeight).toBe(20);
    const rest: ChainEvent[] = [];
    let cursor = first.next;
    for (;;) {
      const page = await db.readEvents(cursor, 7);
      if (!page.events.length) {
        expect(page.next).toBe(cursor);
        break;
      }
      rest.push(...page.events);
      cursor = page.next;
    }
    expect(rest).toEqual(events.slice(2));
    expect((await db.readEvents('12:0', 1)).events[0]).toEqual(events[1]);
    // Each kind read through its index, merged in the log's order.
    const kinds = await db.readEvents('12:0', 3, ['VOTE', 'ENTRY_CREATED']);
    expect(kinds.events.map((e) => eventCursor(e))).toEqual([
      '12:1',
      '15:0',
      '20:0'
    ]);
    await expect(db.readEvents('nope', 1)).rejects.toThrow('height:seq');
    await expect(db.readEvents('12:0@net-2', 1)).rejects.toThrow(
      EventCursorError
    );
    // Nothing above the height the index has applied.
    await db.saveState({ ...(await db.loadState()), feedNext: 16 }, 2);
    const applied = await db.readEvents('12:1', 100);
    expect(applied.events.map((e) => eventCursor(e))).toEqual(['15:0']);
    expect(applied.appliedHeight).toBe(15);
  });

  it('writes a large batch in bounded transactions, and a part written again keeps its rows', async () => {
    // 1,200 events: three transactions, many statements in each.
    const batch = Array.from({ length: 1200 }, (_, i) =>
      anEvent(13, i, { data: { i, big: 'x'.repeat(300) } })
    );
    // The last part fails (a block time no statement takes): the parts
    // before it stay, events_next doesn't move.
    const bad = { ...batch[1199], blockTime: Number.NaN };
    await expect(
      db.writeEvents([...batch.slice(0, 1199), bad], 14, SCAN)
    ).rejects.toThrow();
    const count = async () =>
      Number(
        (
          await sqlExecutor.execute<{ n: number }>(
            `select count(*) as n from ${CHAIN_EVENTS_TABLE}`
          )
        )[0].n
      );
    expect(await count()).toBe(1000);
    expect(await db.loadState()).toMatchObject({
      eventsNext: null,
      scanState: UNKNOWN_SCAN
    });
    // Written again whole, derived the same: the rows there are kept.
    expect(await db.writeEvents(batch, 14, SCAN)).toBe(0);
    expect(await count()).toBe(1200);
    // One derived otherwise is counted (and logged), the stored row kept.
    const changed = batch.map((event, i) =>
      i === 7 ? { ...event, origin: 'SCAN' as const } : event
    );
    expect(await db.writeEvents(changed, 14, SCAN)).toBe(1);
    expect((await db.readEvents('13:6', 1)).events).toEqual([batch[7]]);
    expect(await db.loadState()).toMatchObject({
      eventsNext: 14,
      scanState: SCAN
    });
    const read = await db.readEvents('13:998', 3);
    expect(read.events).toEqual(batch.slice(999, 1002));
  });

  it('writes a gap as an event of its own', async () => {
    await db.writeEvents([gapEvent(11, 20, 5_000)], 21, UNKNOWN_SCAN);
    expect((await db.readEvents(null, 5)).events).toEqual([
      expect.objectContaining({
        height: 20,
        seq: 0,
        kind: 'GAP',
        origin: 'SYSTEM',
        data: { from: 11, to: 20 }
      })
    ]);
  });

  it('finds the objects, votes and last ballots the events name', async () => {
    await db.upsert(
      'waves',
      [waveRow({ waveId: W, legacyId: 'AAAA-1', status: 'open' })],
      stamp
    );
    await db.upsert(
      'decisions',
      [
        decisionRow({
          decisionId: D,
          waveId: W,
          legacyId: null,
          status: 'ended',
          config: { creditScope: 2, creditSource: 4 }
        })
      ],
      stamp
    );
    await db.upsert(
      'entries',
      [
        entryRow({
          entryId: E1,
          decisionId: D,
          legacyId: 'EEEE-1',
          author: V1,
          status: 'winner',
          total: '-170141183460469231731687303715884105728',
          manifestHash: id('fe1')
        })
      ],
      stamp
    );
    await db.upsert(
      'polls',
      [pollRow({ pollId: P, waveId: W, legacyId: 'BBBB-1' })],
      stamp
    );
    await db.upsert('groups', [groupRow({ groupId: G, version: 1 })], stamp);
    await db.upsert(
      'votes',
      [
        voteRow({
          decisionId: D,
          entryId: E1,
          voter: V1,
          value: '-9223372036854775808',
          updatedHeight: 9
        })
      ],
      { height: 10, generation: 3 }
    );
    const objects = await db.eventObjects({
      entries: [E1, E2],
      decisions: [D],
      waves: [W],
      polls: [P],
      groups: [G]
    });
    expect(Object.fromEntries(objects.entries)).toEqual({
      [E1]: {
        legacyId: 'eeee-1',
        decisionId: D,
        author: V1,
        total: '-170141183460469231731687303715884105728',
        manifestHash: id('fe1')
      }
    });
    expect(objects.decisions.get(D)).toEqual({
      legacyId: null,
      waveId: W,
      creditScope: 2,
      creditSource: 4,
      status: 'ended',
      statusHeight: 10
    });
    expect(objects.waves.get(W)).toEqual({ legacyId: 'aaaa-1' });
    expect(objects.polls.get(P)).toEqual({ legacyId: 'bbbb-1', waveId: W });
    expect(objects.groups.get(G)).toEqual({ legacyId: null });

    const votes = await db.eventVotes([
      { decisionId: D, entryId: E1, voter: V1 },
      { decisionId: D, entryId: E2, voter: V1 }
    ]);
    expect(Object.fromEntries(votes)).toEqual({
      [`${D}:${E1}:${V1}`]: {
        value: '-9223372036854775808',
        updatedHeight: 9,
        generation: 3
      }
    });

    await db.writeEvents(
      [
        ballot(11, C1, 1, 1),
        { ...ballot(11, C2, 2, 1), seq: 1 },
        ballot(14, C1, 6, 2),
        ballot(18, C1, 4, 3)
      ],
      19,
      UNKNOWN_SCAN
    );
    const ballots = await db.lastBallots(
      [
        { pollId: P, cid: C1 },
        { pollId: P, cid: C2 },
        { pollId: P, cid: id('c3') }
      ],
      18
    );
    expect(Object.fromEntries(ballots)).toEqual({
      [`${P}:${C1}`]: { selection: 6, version: 2 },
      [`${P}:${C2}`]: { selection: 2, version: 1 }
    });
  });

  it('looks up many ids in statements of a bounded size', async () => {
    const entries = Array.from({ length: 400 }, (_, i) =>
      entryRow({
        entryId: id(`e${i}`),
        decisionId: D,
        author: V1,
        status: 'active',
        total: String(i)
      })
    );
    await db.upsert('entries', entries, stamp);
    const objects = await db.eventObjects({
      entries: entries.map((e) => e.entry_id as string)
    });
    expect(objects.entries.size).toBe(400);
    const votes = await db.eventVotes(
      entries.map((e) => ({
        decisionId: D,
        entryId: e.entry_id as string,
        voter: V1
      }))
    );
    expect(votes.size).toBe(0);
  });

  it('empties the log with the index', async () => {
    await db.writeEvents([anEvent(12, 0)], 13, UNKNOWN_SCAN);
    await db.clearAll();
    expect(
      await sqlExecutor.execute(`select * from ${CHAIN_EVENTS_TABLE}`)
    ).toEqual([]);
  });
});
