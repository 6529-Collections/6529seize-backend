jest.mock('@/secrets', () => ({
  doInDbContext: (operation: () => Promise<void>) => operation()
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (handler: unknown) => handler
}));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ info: jest.fn() }) }
}));
jest.mock('./native-competition-runtime.service', () => ({
  nativeCompetitionRuntimeService: {
    processDueCompetitions: jest.fn(),
    refreshNativeLeaderboards: jest.fn()
  }
}));
jest.mock('./competition-event-dispatcher', () => ({
  competitionEventDispatcher: { dispatchPending: jest.fn() }
}));

import { handler as decisionHandler } from '@/waveDecisionExecutionLoop';
import { handler as leaderboardHandler } from '@/waveLeaderboardSnapshotterLoop';
import { nativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { competitionEventDispatcher } from './competition-event-dispatcher';

beforeEach(() => jest.resetAllMocks());

it('keeps the decision unit processing native work and pending durable effects', async () => {
  const order: string[] = [];
  jest
    .mocked(competitionEventDispatcher.dispatchPending)
    .mockImplementation(async () => {
      order.push('dispatch');
    });
  jest
    .mocked(nativeCompetitionRuntimeService.processDueCompetitions)
    .mockImplementation(async () => {
      order.push('decisions');
    });
  await decisionHandler({} as never, {} as never, jest.fn());
  // Delivery gets its share first, then again after the decision pass.
  expect(order).toEqual(['dispatch', 'decisions', 'dispatch']);
  expect(
    nativeCompetitionRuntimeService.processDueCompetitions
  ).toHaveBeenCalledWith(
    expect.objectContaining({
      budgetMs: 300_000,
      competitionDeadlineMs: 120_000,
      reserveMillis: 300_000
    })
  );
  expect(competitionEventDispatcher.dispatchPending).toHaveBeenNthCalledWith(
    1,
    expect.anything(),
    expect.any(Number),
    { budgetMs: 60_000 }
  );
});

it('gives the last delivery what is left of the invocation', async () => {
  let remaining = 600_000;
  jest
    .mocked(nativeCompetitionRuntimeService.processDueCompetitions)
    .mockImplementation(async () => {
      remaining = 400_000;
    });
  await decisionHandler(
    {} as never,
    { getRemainingTimeInMillis: () => remaining } as never,
    jest.fn()
  );
  expect(competitionEventDispatcher.dispatchPending).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.any(Number),
    { budgetMs: 370_000 }
  );
});

it('still drains pending effects when native decision processing fails', async () => {
  const failure = new Error('decision failed');
  jest
    .mocked(nativeCompetitionRuntimeService.processDueCompetitions)
    .mockRejectedValue(failure);
  await expect(
    decisionHandler({} as never, {} as never, jest.fn())
  ).rejects.toBe(failure);
  expect(competitionEventDispatcher.dispatchPending).toHaveBeenCalledTimes(2);
});

it('keeps the leaderboard unit refreshing native leaderboards', async () => {
  await leaderboardHandler({} as never, {} as never, jest.fn());
  expect(
    nativeCompetitionRuntimeService.refreshNativeLeaderboards
  ).toHaveBeenCalledTimes(1);
});
