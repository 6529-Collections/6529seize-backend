import {
  decisionRow,
  entryRow,
  groupRow,
  hasKeys,
  leaderboardEntryRows,
  leaderboardRow,
  pollRow,
  resultRow,
  roleRow,
  voteRow,
  waveRepRow,
  waveRow
} from './waves-chain-index.rows';
import { statementChunks } from './waves-chain-index.db';

const id = (n: number | string) => `0x${String(n).padStart(64, '0')}`;
const ZERO = id(0);

describe('index rows', () => {
  it('keeps a wave its group columns, no group for the zero id', () => {
    const wave = {
      waveId: id('AB'),
      legacyId: '8FE9-AAAA',
      status: 'closed',
      membersOnly: true,
      readGroup: { groupId: id('C1'), version: 0 },
      postGroup: { groupId: ZERO, version: 0 },
      adminGroup: null,
      origin: 'legacy'
    };
    expect(waveRow(wave)).toEqual({
      wave_id: id('ab'),
      legacy_id: '8fe9-aaaa',
      status: 'closed',
      members_only: true,
      read_group_id: id('c1'),
      post_group_id: null,
      admin_group_id: null,
      origin: 'legacy',
      data: wave
    });
  });

  it('keeps large amounts as decimal text', () => {
    const entry = {
      entryId: id(1),
      decisionId: id(2),
      author: id(3),
      status: 'active',
      total: '340282366920938463463374607431768211455'
    };
    expect(entryRow(entry)).toMatchObject({
      total: '340282366920938463463374607431768211455',
      legacy_id: null,
      origin: 'native'
    });
    expect(
      voteRow({
        decisionId: id(2),
        entryId: id(1),
        voter: id(4),
        value: '-9223372036854775808',
        updatedHeight: 12
      })
    ).toEqual({
      decision_id: id(2),
      entry_id: id(1),
      voter: id(4),
      value: '-9223372036854775808',
      updated_height: 12
    });
  });

  it('maps decisions, groups, roles, polls, results and leaderboards', () => {
    expect(
      decisionRow({
        decisionId: id(5),
        waveId: id(6),
        status: 'published',
        kind: 'rank',
        nextResultTime: 1764000000000,
        due: true
      })
    ).toMatchObject({
      decision_id: id(5),
      wave_id: id(6),
      next_result_time: 1764000000000,
      due: true
    });
    expect(groupRow({ groupId: id(7), version: 3 })).toMatchObject({
      group_id: id(7),
      version: 3
    });
    expect(
      roleRow(id(6), { role: 'moderator', principalId: id(8), live: false })
    ).toMatchObject({ role: 'moderator', principal_id: id(8), live: false });
    expect(
      pollRow({ pollId: id(9), waveId: id(6), status: 'open' })
    ).toMatchObject({
      poll_id: id(9),
      wave_id: id(6)
    });
    expect(
      resultRow(id(5), {
        resultTime: 1764000000000,
        status: 'decided',
        stage: 'final'
      })
    ).toMatchObject({ decision_id: id(5), result_time: 1764000000000 });
  });

  it('keeps a board without its rows, and no time in a board ranked by total', () => {
    const rows = [
      {
        rank: 1,
        entryId: id('E1'),
        legacyId: 'AAAA-1',
        author: id('A'),
        score: '123456789012345678901234567890123456789012345678901234567890',
        total: '9',
        createdMs: 5
      }
    ];
    expect(
      leaderboardRow(id(5), {
        by: 'time_weighted_score',
        scoredAt: 77,
        count: 1,
        rows
      })
    ).toEqual({
      decision_id: id(5),
      scored_at: 77,
      data: { by: 'time_weighted_score', scoredAt: 77, count: 1 }
    });
    expect(
      leaderboardRow(id(5), { by: 'total', scoredAt: 77, count: 1, rows })
    ).toEqual({
      decision_id: id(5),
      scored_at: 0,
      data: { by: 'total', count: 1 }
    });
    expect(leaderboardEntryRows(id(5), { rows })).toEqual([
      {
        decision_id: id(5),
        entry_id: id('e1'),
        rank: 1,
        legacy_id: 'aaaa-1',
        author: id('a'),
        score: '123456789012345678901234567890123456789012345678901234567890',
        total: '9',
        data: rows[0]
      }
    ]);
    expect(leaderboardEntryRows(id(5), {})).toEqual([]);
  });

  it('keeps no live score in an entry', () => {
    const row = entryRow({ entryId: id(1), total: '5', score: '50' });
    expect(row.data).toEqual({ entryId: id(1), total: '5' });
    expect(entryRow({ entryId: id(1), total: 'x' }).total).toBe('0');
  });

  it('keys a wave REP rating by its category id', () => {
    expect(
      waveRepRow(id(6), {
        rater: id(1),
        category: { id: id('CA'), name: 'Builder' },
        value: -4,
        updatedHeight: 9
      })
    ).toEqual({
      wave_id: id(6),
      rater: id(1),
      category_id: id('ca'),
      category_name: 'Builder',
      value: -4,
      updated_height: 9
    });
    expect(
      waveRepRow(id(6), { rater: id(1), category: id('CB'), value: 1 })
    ).toMatchObject({ category_id: id('cb'), category_name: null });
  });

  it('tells a row without its keys', () => {
    expect(hasKeys(waveRow({}), ['wave_id'])).toBe(false);
    expect(hasKeys(waveRow({ waveId: id(1) }), ['wave_id'])).toBe(true);
  });
});

describe('statementChunks', () => {
  it('keeps statements under the row and byte bounds', () => {
    const sizes = [5000, 5000, 5000, 20000, 1, 1];
    expect(statementChunks(sizes, (n) => n)).toEqual([
      [5000, 5000],
      [5000],
      [20000],
      [1, 1]
    ]);
    const many = Array.from({ length: 450 }, () => 1);
    expect(statementChunks(many, (n) => n).map((c) => c.length)).toEqual([
      200, 200, 50
    ]);
  });
});
