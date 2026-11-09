import {
  NativeCompetitionRuntimeRepository,
  NativeHistoryRow,
  NativeRuntimeEntry,
  NativeLeaderboardRow
} from './native-competition-runtime.repository';
import { NativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { competitionExecutionRouter } from './competition-execution.router';
import { Competition } from './competition.types';

const credits = {
  getBudget: jest.fn(),
  getWaveBudgets: jest.fn(),
  getDropBudgets: jest.fn()
};

it('a leaderboard refresh loads only totals and preserves the full-history reader for decisions', async () => {
  const repository = {
    listActiveEntries: jest.fn().mockResolvedValue([]),
    listAggregateHistory: jest.fn().mockResolvedValue([]),
    listHistory: jest.fn().mockResolvedValue([]),
    listPauses: jest.fn().mockResolvedValue([]),
    saveLeaderboard: jest.fn().mockResolvedValue(false)
  };
  const service = new NativeCompetitionRuntimeService(
    repository as unknown as NativeCompetitionRuntimeRepository,
    credits,
    competitionExecutionRouter
  );
  const ctx = { connection: { connection: {} } };
  await service.refreshLeaderboardAfterCreditReconciliation(
    {
      id: 'c',
      decisions: { time_lock_ms: 1000, next_decision_time: 2000 }
    } as Competition,
    1500,
    ctx
  );
  expect(repository.listAggregateHistory).toHaveBeenCalledWith('c', ctx);
  expect(repository.listHistory).not.toHaveBeenCalled();
});

it.each([0, 1000])(
  'preserves scores, threshold times and tie order with time lock %i',
  async (timeLock) => {
    const entries = ['a', 'b'].map(
      (id) =>
        ({
          id,
          competition_id: 'c',
          drop_id: id,
          submitted_at: 0,
          real_time_rating: 10,
          last_increased_at: 500
        }) as NativeRuntimeEntry
    );
    const aggregate: NativeHistoryRow[] = [];
    entries.forEach((entry, index) => {
      const values = index === 0 ? [4, 12, 10] : [12, 12, 10];
      [100, 500, 1000].forEach((timestamp, offset) => {
        aggregate.push({
          entry_id: entry.id,
          voter_profile_id: '',
          kind: 'AGGREGATE',
          value: 0,
          aggregate_value: values[offset],
          occurred_at: timestamp,
          sequence: index * 10 + offset,
          order_sequence: index * 10 + offset
        });
      });
    });
    const full: NativeHistoryRow[] = [
      ...aggregate,
      ...entries.map((entry, index) => ({
        entry_id: entry.id,
        voter_profile_id: 'individual',
        kind: 'VOTER' as const,
        value: 9999,
        aggregate_value: 0,
        occurred_at: 1200,
        sequence: 100 + index,
        order_sequence: 100 + index
      }))
    ];
    async function standings(
      history: NativeHistoryRow[]
    ): Promise<readonly NativeLeaderboardRow[]> {
      let saved: readonly NativeLeaderboardRow[] = [];
      const repository = {
        listActiveEntries: jest.fn().mockResolvedValue(entries),
        listAggregateHistory: jest.fn().mockResolvedValue(history),
        listPauses: jest.fn().mockResolvedValue([]),
        saveLeaderboard: jest.fn(
          async (_id: string, rows: readonly NativeLeaderboardRow[]) => {
            saved = rows;
            return false;
          }
        )
      };
      const service = new NativeCompetitionRuntimeService(
        repository as unknown as NativeCompetitionRuntimeRepository,
        credits,
        competitionExecutionRouter
      );
      await service.refreshLeaderboardAfterCreditReconciliation(
        {
          id: 'c',
          decisions: {
            time_lock_ms: timeLock,
            next_decision_time: 2000,
            winning_min_threshold: 5
          }
        } as Competition,
        1500,
        { connection: { connection: {} } }
      );
      return saved;
    }
    const actual = await standings(aggregate);
    expect(actual).toEqual(await standings(full));
    expect(actual.map((row) => row.rating)).toEqual([
      timeLock === 0 ? 10 : 11,
      timeLock === 0 ? 10 : 11
    ]);
    expect(actual.map((row) => row.entry.id)).toEqual(
      timeLock === 0 ? ['b', 'a'] : ['a', 'b']
    );
  }
);
