import { NativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { NativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { competitionCreditService } from './competition-credit.service';
import { competitionExecutionRouter } from './competition-execution.router';
import { Competition } from './competition.types';

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
    competitionCreditService,
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
