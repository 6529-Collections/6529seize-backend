import 'reflect-metadata';
import {
  CHAIN_ENTRIES_TABLE,
  CHAIN_LEADERBOARD_ROWS_TABLE,
  CHAIN_VOTES_TABLE
} from '@/constants/db-tables';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { EMPTY_INDEX_STATE, WavesChainIndexDb } from './waves-chain-index.db';
import {
  decisionRow,
  entryRow,
  leaderboardEntryRows,
  roleRow,
  voteRow,
  waveRow
} from './waves-chain-index.rows';

const id = (n: number | string) => `0x${String(n).padStart(64, '0')}`;
const W = id('a1');
const D = id('d1');
const E1 = id('e1');
const E2 = id('e2');
const V1 = id('f1');
const V2 = id('f2');

function aWave(fields: Record<string, unknown> = {}) {
  return {
    waveId: W,
    legacyId: 'AAAA-1',
    status: 'open',
    membersOnly: false,
    readGroup: { groupId: id(0), version: 0 },
    postGroup: { groupId: id('c1'), version: 0 },
    adminGroup: { groupId: id(0), version: 0 },
    origin: 'legacy',
    ...fields
  };
}

function aVote(entryId: string, voter: string, value: string, at: number) {
  return voteRow({
    decisionId: D,
    entryId,
    voter,
    value,
    updatedHeight: at
  });
}

describeWithSeed('WavesChainIndexDb', [], () => {
  const db = new WavesChainIndexDb(() => sqlExecutor);

  it('saves and loads its state', async () => {
    expect(await db.loadState()).toEqual(EMPTY_INDEX_STATE);
    const state = {
      generation: 3,
      fullPhase: 'decisions',
      fullAfter: `${D}:${E1}`,
      fullFromHeight: 120,
      lastFullAt: 1_764_000_000_000,
      feedNext: 121,
      readHeight: 130,
      network: 'net-1',
      lastError: 'x'.repeat(3000),
      eventsNext: 125,
      trustFrom: 2,
      scanState: { scanning: 0, finishedDay: 20612, reducing: null },
      voteRereads: { entries: [`${D}`], votes: [`${D}:${E1}:${D}`] },
      feedPart: 2,
      importStartedAt: 1_763_990_000_000
    };
    await db.saveState(state, 5);
    expect(await db.loadState()).toEqual({
      ...state,
      lastError: 'x'.repeat(2000)
    });
    await db.saveState({ ...state, fullPhase: null, lastError: null }, 6);
    expect(await db.loadState()).toMatchObject({
      fullPhase: null,
      lastError: null
    });
  });

  it('writes rows, and never lets an older read overwrite a newer one', async () => {
    await db.upsert('waves', [waveRow(aWave())], {
      height: 10,
      generation: 1
    });
    const [first] = await db.dump('waves');
    expect(first).toMatchObject({
      wave_id: W,
      legacy_id: 'aaaa-1',
      status: 'open',
      members_only: false,
      read_group_id: null,
      post_group_id: id('c1'),
      height: 10,
      generation: 1
    });
    expect(
      typeof first.data === 'string' ? JSON.parse(first.data) : first.data
    ).toEqual(aWave());

    await db.upsert('waves', [waveRow(aWave({ status: 'closed' }))], {
      height: 12,
      generation: 1
    });
    // Read at a lower height: only the generation moves.
    await db.upsert('waves', [waveRow(aWave({ status: 'open' }))], {
      height: 11,
      generation: 2
    });
    expect((await db.dump('waves'))[0]).toMatchObject({
      status: 'closed',
      height: 12,
      generation: 2
    });
    // The same height: the newer read wins.
    await db.upsert(
      'waves',
      [waveRow(aWave({ status: 'open', membersOnly: true }))],
      { height: 12, generation: 2 }
    );
    expect((await db.dump('waves'))[0]).toMatchObject({
      status: 'open',
      members_only: true
    });
  });

  it('writes many rows at once and drops rows without their keys', async () => {
    const entries = Array.from({ length: 450 }, (_, i) =>
      entryRow({
        entryId: id(`e${i}`),
        decisionId: D,
        author: id('a'),
        status: 'active',
        total: '340282366920938463463374607431768211455'
      })
    );
    await db.upsert('entries', [...entries, entryRow({ decisionId: D })], {
      height: 5,
      generation: 1
    });
    expect(await db.dump('entries')).toHaveLength(450);
    const [{ total }] = await sqlExecutor.execute(
      `select cast(total as char) as total from ${CHAIN_ENTRIES_TABLE} limit 1`
    );
    expect(total).toBe('340282366920938463463374607431768211455');
  });

  it('keeps leaderboard scores of 60 digits', async () => {
    const score = '1'.repeat(60);
    await db.upsert(
      'leaderboardRows',
      leaderboardEntryRows(D, {
        rows: [{ rank: 1, entryId: E1, author: V1, score, total: '-5' }]
      }),
      { height: 1, generation: 1 }
    );
    const rows = await sqlExecutor.execute(
      `select decision_id, entry_id, \`rank\`, cast(score as char) as score,
              cast(total as char) as total from ${CHAIN_LEADERBOARD_ROWS_TABLE}`
    );
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { decision_id: D, entry_id: E1, rank: 1, score, total: '-5' }
    ]);
  });

  it('replaces the rows under one parent only', async () => {
    const stamp = { height: 5, generation: 1 };
    await db.upsert(
      'roles',
      [
        roleRow(W, { role: 'admin', principalId: V1 }),
        roleRow(W, { role: 'moderator', principalId: V2 }),
        roleRow(id('a2'), { role: 'admin', principalId: V1 })
      ],
      stamp
    );
    await db.replaceChildren(
      'roles',
      'wave_id',
      W,
      [roleRow(W, { role: 'curator', principalId: V2, live: false })],
      { height: 6, generation: 1 }
    );
    expect(
      (await db.dump('roles')).map((r) => [r.wave_id, r.role, r.live])
    ).toEqual([
      [W, 'curator', false],
      [id('a2'), 'admin', true]
    ]);
  });

  it('applies the feed votes unless the stored one is newer', async () => {
    const stamp = { height: 20, generation: 1 };
    await db.upsert(
      'votes',
      [aVote(E1, V1, '5', 18), aVote(E1, V2, '-2', 25), aVote(E2, V1, '1', 10)],
      stamp
    );
    await db.applyVotes(
      [
        // newer: taken
        {
          decisionId: D,
          entryId: E1,
          voter: V1,
          value: '7',
          updatedHeight: 19
        },
        // older than stored: kept as is
        {
          decisionId: D,
          entryId: E1,
          voter: V2,
          value: '3',
          updatedHeight: 21
        },
        // a new vote
        {
          decisionId: D,
          entryId: E2,
          voter: V2,
          value: '-9223372036854775808',
          updatedHeight: 21
        },
        // a deletion after the stored vote
        {
          decisionId: D,
          entryId: E2,
          voter: V1,
          value: null,
          updatedHeight: 21
        }
      ],
      { height: 21, generation: 2 }
    );
    // A deletion older than the stored vote: kept.
    await db.applyVotes(
      [
        {
          decisionId: D,
          entryId: E1,
          voter: V2,
          value: null,
          updatedHeight: 24
        }
      ],
      { height: 24, generation: 2 }
    );
    const rows = await sqlExecutor.execute(
      `select entry_id, voter, cast(value as char) as value, updated_height,
              height, generation
         from ${CHAIN_VOTES_TABLE} order by entry_id, voter`
    );
    expect(rows.map((r) => ({ ...r }))).toEqual([
      {
        entry_id: E1,
        voter: V1,
        value: '7',
        updated_height: 19,
        height: 21,
        generation: 2
      },
      {
        entry_id: E1,
        voter: V2,
        value: '-2',
        updated_height: 25,
        height: 21,
        generation: 2
      },
      {
        entry_id: E2,
        voter: V2,
        value: '-9223372036854775808',
        updated_height: 21,
        height: 21,
        generation: 2
      }
    ]);
  });

  it('sweeps the rows a full read did not see, in every table', async () => {
    await db.upsert('waves', [waveRow(aWave())], { height: 1, generation: 1 });
    await db.upsert('votes', [aVote(E1, V1, '1', 1), aVote(E2, V1, '1', 1)], {
      height: 1,
      generation: 1
    });
    await db.upsert('votes', [aVote(E2, V1, '1', 1)], {
      height: 2,
      generation: 2
    });
    const removed = await db.sweep(2);
    expect(removed).toMatchObject({ waves: 1, votes: 1, entries: 0 });
    expect((await db.dump('votes')).map((v) => v.entry_id)).toEqual([E2]);
  });

  it('finds what moves with time, stalest first', async () => {
    await db.upsert(
      'decisions',
      [
        decisionRow({
          decisionId: id('d1'),
          waveId: W,
          status: 'published',
          counted: true
        }),
        // Ranked by total: nothing moves with time.
        decisionRow({ decisionId: id('d2'), waveId: W, status: 'published' }),
        decisionRow({
          decisionId: id('d5'),
          waveId: W,
          status: 'ended',
          counted: true
        }),
        decisionRow({
          decisionId: id('d4'),
          waveId: W,
          status: 'archived',
          counted: true,
          due: true
        })
      ],
      { height: 5, generation: 1 }
    );
    await db.upsert(
      'decisions',
      [
        decisionRow({
          decisionId: id('d3'),
          waveId: W,
          status: 'archived',
          counted: true,
          phase: 'settling'
        })
      ],
      { height: 3, generation: 1 }
    );
    const stamp = { height: 1, generation: 1 };
    await db.upsert(
      'roles',
      [
        roleRow(id('a1'), { role: 'admin', principalId: V1, expiresAt: 500 }),
        roleRow(id('a2'), { role: 'admin', principalId: V1, expiresAt: 0 }),
        roleRow(id('a3'), { role: 'admin', principalId: V1, expiresAt: 900 }),
        roleRow(id('a4'), {
          role: 'admin',
          principalId: V1,
          expiresAt: 100,
          live: false
        }),
        roleRow(id('a5'), {
          role: 'admin',
          principalId: V1,
          expiresAt: '400'
        })
      ],
      stamp
    );
    expect(await db.timeDependent(600)).toEqual({
      decisionIds: [id('d3'), id('d1'), id('d4')],
      roleWaveIds: [id('a1'), id('a5')]
    });
  });

  it('tells decisions by their stored status, and empties every table', async () => {
    await db.upsert(
      'decisions',
      [
        decisionRow({
          decisionId: id('d1'),
          waveId: W,
          status: 'published',
          counted: true
        }),
        decisionRow({ decisionId: id('d2'), waveId: W, status: 'ended' })
      ],
      { height: 1, generation: 1 }
    );
    await db.upsert('votes', [aVote(E1, V1, '1', 1)], {
      height: 1,
      generation: 1
    });
    const statuses = await db.decisionStatuses([id('d1'), id('d2'), id('d9')]);
    expect(Array.from(statuses.entries())).toEqual([
      [id('d1'), { status: 'published', counted: true }],
      [id('d2'), { status: 'ended', counted: false }]
    ]);
    expect((await db.decisionStatuses([])).size).toBe(0);
    await db.clearAll();
    expect(await db.dump('decisions')).toEqual([]);
    expect(await db.dump('votes')).toEqual([]);
  });
});
