import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { WavesChainIndexDb } from './waves-chain-index.db';
import { roleRow, voteRow } from './waves-chain-index.rows';

const id = (n: number | string) => `0x${String(n).padStart(64, '0')}`;

/**
 * The index replaces a parent's children (a wave's roles, an entry's votes)
 * from 8 reads at once; into empty tables, as on the first full read.
 */
describeWithSeed('WavesChainIndexDb: children replaced at once', [], () => {
  const db = new WavesChainIndexDb(() => sqlExecutor);

  it('replaces 8 parents at once into an empty table, again and again', async () => {
    for (let round = 0; round < 5; round++) {
      await Promise.all(
        Array.from({ length: 8 }, (_, w) =>
          db.replaceChildren(
            'roles',
            'wave_id',
            id(`a${w}`),
            Array.from({ length: 6 }, (_, p) =>
              roleRow(id(`a${w}`), {
                role: 'admin',
                principalId: id(`f${round}${p}`),
                live: true
              })
            ),
            { height: 10 + round, generation: 1 }
          )
        )
      );
      await Promise.all(
        Array.from({ length: 8 }, (_, e) =>
          db.replaceChildren(
            'votes',
            'entry_id',
            id(`e${e}`),
            Array.from({ length: 6 }, (_, v) =>
              voteRow({
                decisionId: id('d1'),
                entryId: id(`e${e}`),
                voter: id(`f${round}${v}`),
                value: String(v + 1),
                updatedHeight: 10 + round
              })
            ),
            { height: 10 + round, generation: 1 }
          )
        )
      );
    }
    const last = new Set(Array.from({ length: 6 }, (_, p) => id(`f4${p}`)));
    const roles = await db.dump('roles');
    expect(roles).toHaveLength(48);
    expect(roles.every((r) => last.has(String(r.principal_id)))).toBe(true);
    expect(await db.dump('votes')).toHaveLength(48);
  });

  it('writes only the leaderboard rows that moved, and keeps the rest in the full read', async () => {
    const D = id('d1');
    const row = (entry: number, rank: number, total: string) => ({
      decision_id: D,
      entry_id: id(`e${entry}`),
      rank,
      legacy_id: null,
      author: id('a1'),
      score: total,
      total,
      data: { rank, entryId: id(`e${entry}`), total, score: total }
    });
    const board = [row(1, 1, '30'), row(2, 2, '20'), row(3, 3, '10')];
    expect(
      await db.writeLeaderboardRows(D, board, { height: 5, generation: 1 })
    ).toBe(3);
    // The same board: nothing written.
    expect(
      await db.writeLeaderboardRows(D, board, { height: 6, generation: 1 })
    ).toBe(0);
    // E3 passes E2, E1 is gone, E4 is new.
    const next = [row(3, 1, '25'), row(2, 2, '20'), row(4, 3, '5')];
    expect(
      await db.writeLeaderboardRows(D, next, { height: 7, generation: 2 })
    ).toBe(3);
    const stored = await db.dump('leaderboardRows');
    expect(
      stored.map((r) => [r.entry_id, Number(r.rank), Number(r.height)])
    ).toEqual([
      [id('e2'), 2, 5],
      [id('e3'), 1, 7],
      [id('e4'), 3, 7]
    ]);
    // Every row of the board is in the full read's generation.
    expect(stored.every((r) => Number(r.generation) === 2)).toBe(true);
    expect(await db.sweep(2)).toMatchObject({ leaderboardRows: 0 });
  });
});
