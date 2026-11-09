import { competitionScoreResetRepository as repository } from '@/competitions/competition-score-reset.repository';
import { runCompetitionScoreResetsScope } from './competition-score-resets-scope';

jest.mock('@/competitions/competition-score-reset.repository', () => ({
  competitionScoreResetRepository: {
    progress: jest.fn().mockResolvedValue({
      reads_enabled: false,
      backfill_complete: false,
      after_competition_id: ''
    }),
    backfillNext: jest.fn(),
    setReadsEnabled: jest.fn()
  }
}));

beforeEach(() => jest.clearAllMocks());

it('defaults to read-only status and requires an explicit writer rollout assertion', async () => {
  await runCompetitionScoreResetsScope({});
  expect(repository.backfillNext).not.toHaveBeenCalled();
  expect(repository.setReadsEnabled).not.toHaveBeenCalled();
  for (const action of ['backfill', 'enable']) {
    await expect(runCompetitionScoreResetsScope({ action })).rejects.toThrow(
      'writers'
    );
  }
});

it('bounds each invocation and stops when backfill completes', async () => {
  jest
    .mocked(repository.backfillNext)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  expect(
    await runCompetitionScoreResetsScope({
      action: 'backfill',
      writers_deployed: true,
      limit: 5
    })
  ).toMatchObject({ processed: 1 });
  expect(repository.backfillNext).toHaveBeenCalledTimes(2);
  jest.mocked(repository.backfillNext).mockResolvedValue(true);
  await runCompetitionScoreResetsScope({
    action: 'backfill',
    writers_deployed: true,
    limit: 2
  });
  expect(repository.backfillNext).toHaveBeenCalledTimes(4);
});

it.each([0, 101, 1.5, '10', null])(
  'rejects invalid limit %j',
  async (limit) => {
    await expect(
      runCompetitionScoreResetsScope({
        action: 'backfill',
        writers_deployed: true,
        limit
      })
    ).rejects.toThrow('limit');
  }
);

it('supports an explicit rollback without repeating the writer assertion', async () => {
  await runCompetitionScoreResetsScope({ action: 'disable' });
  expect(repository.setReadsEnabled).toHaveBeenCalledWith(false);
});
