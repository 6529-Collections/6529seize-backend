import { DROP_REAL_VOTE_IN_TIME_TABLE, DROPS_TABLE } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed, Seed } from '@/tests/_setup/seed';
import { DropVotingDb } from './drop-voting.db';

let repo: DropVotingDb;
beforeEach(() => {
  repo = new DropVotingDb(() => sqlExecutor);
});
const waveId = 'history-wave';
const dropIds = ['boundary', 'imported', 'inside-only', 'empty', 'winner'];
const dropSeed: Seed = {
  table: DROPS_TABLE,
  rows: dropIds.map((id) => ({
    id,
    wave_id: waveId,
    author_id: 'history-author',
    created_at: 0,
    parts_count: 1,
    drop_type: id === 'winner' ? DropType.WINNER : DropType.PARTICIPATORY
  }))
};
const historySeed: Seed = {
  table: DROP_REAL_VOTE_IN_TIME_TABLE,
  rows: [
    ...[
      { id: 1, drop_id: 'boundary', timestamp: 90, vote: 1 },
      { id: 2, drop_id: 'boundary', timestamp: 100, vote: 2 },
      { id: 3, drop_id: 'boundary', timestamp: 100, vote: 3 },
      { id: 4, drop_id: 'boundary', timestamp: 150, vote: 10 },
      { id: 5, drop_id: 'boundary', timestamp: 200, vote: 99 },
      { id: 6, drop_id: 'imported', timestamp: 90, vote: 7 },
      { id: 7, drop_id: 'imported', timestamp: 80, vote: -2 },
      { id: 8, drop_id: 'imported', timestamp: 150, vote: 0 },
      { id: 9, drop_id: 'inside-only', timestamp: 150, vote: -3 },
      { id: 10, drop_id: 'winner', timestamp: 90, vote: 5 }
    ],
    // Keep both history branches selective even with freshly seeded statistics.
    ...Array.from({ length: 10000 }, (_, index) => ({
      id: 100 + index,
      drop_id: 'unrelated-history',
      timestamp: index,
      vote: index
    }))
  ].map((row) => ({ ...row, wave_id: waveId }))
};

type HistoryMethod =
  | 'getDropVoteStatesInTimespan'
  | 'getDropsParticipatoryDropsVoteStatesInTimespan';
const historyMethods: HistoryMethod[] = [
  'getDropVoteStatesInTimespan',
  'getDropsParticipatoryDropsVoteStatesInTimespan'
];

type QueryPlan = {
  table_name?: string;
  access_type?: string;
  [key: string]: unknown;
};

function historyTableScans(plan: QueryPlan): QueryPlan[] {
  const scans =
    [DROP_REAL_VOTE_IN_TIME_TABLE, 'drv_1', 'drv_2', 'drv_2_i'].includes(
      plan.table_name ?? ''
    ) && plan.access_type === 'ALL'
      ? [plan]
      : [];
  for (const value of Object.values(plan)) {
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (child && typeof child === 'object') {
        scans.push(...historyTableScans(child as QueryPlan));
      }
    }
  }
  return scans;
}

describeWithSeed(
  'DropVotingDb single-drop vote history',
  [dropSeed, historySeed],
  () => {
    describe.each(historyMethods)('%s', (method) => {
      it.each([
        {
          name: 'includes the last state at the start and excludes the end boundary',
          dropId: 'boundary',
          fromTime: 100,
          toTime: 200,
          expected: [
            { timestamp: 100, vote: 3 },
            { timestamp: 150, vote: 10 }
          ]
        },
        {
          name: 'preserves maximum-ID ordering for imported history and zero votes',
          dropId: 'imported',
          fromTime: 100,
          toTime: 200,
          expected: [
            { timestamp: 100, vote: -2 },
            { timestamp: 150, vote: 0 }
          ]
        },
        {
          name: 'returns in-window changes when no earlier state exists',
          dropId: 'inside-only',
          fromTime: 100,
          toTime: 200,
          expected: [{ timestamp: 150, vote: -3 }]
        },
        {
          name: 'carries the last state forward after all history',
          dropId: 'boundary',
          fromTime: 300,
          toTime: 400,
          expected: [{ timestamp: 300, vote: 99 }]
        },
        {
          name: 'returns no states for an entry without history',
          dropId: 'empty',
          fromTime: 100,
          toTime: 200,
          expected: []
        }
      ])('$name', async ({ dropId, fromTime, toTime, expected }) => {
        const actual = await repo[method]({ dropId, fromTime, toTime }, {});
        expect(actual.sort((a, b) => a.timestamp - b.timestamp)).toEqual(
          expected.map((row) => ({
            ...row,
            drop_id: dropId,
            wave_id: waveId
          }))
        );
      });

      it('uses indexed history access instead of scanning unrelated entries', async () => {
        const params = { dropId: 'boundary', fromTime: 100, toTime: 200 };
        const execute = jest.spyOn(sqlExecutor, 'execute');
        try {
          await repo[method](params, {});
          const [sql] = execute.mock.calls[0];
          const [plan] = await sqlExecutor.execute<{ EXPLAIN: string }>(
            `explain format=json ${sql}`,
            params
          );
          expect(historyTableScans(JSON.parse(plan.EXPLAIN))).toEqual([]);
        } finally {
          execute.mockRestore();
        }
      });
    });

    it('preserves the participatory-only filter', async () => {
      const params = { dropId: 'winner', fromTime: 100, toTime: 200 };
      expect(await repo.getDropVoteStatesInTimespan(params, {})).toHaveLength(
        1
      );
      expect(
        await repo.getDropsParticipatoryDropsVoteStatesInTimespan(params, {})
      ).toEqual([]);
    });

    it('retains one pre-window state for every drop in the grouped wave query', async () => {
      const actual = await repo.getWavesParticipatoryDropsVoteStatesInTimespan(
        { waveId, fromTime: 100, toTime: 200 },
        {}
      );
      expect(
        actual
          .filter((row) => row.timestamp === 100)
          .sort((a, b) => a.drop_id.localeCompare(b.drop_id))
      ).toEqual([
        { drop_id: 'boundary', wave_id: waveId, timestamp: 100, vote: 3 },
        { drop_id: 'imported', wave_id: waveId, timestamp: 100, vote: -2 }
      ]);
    });
  }
);
