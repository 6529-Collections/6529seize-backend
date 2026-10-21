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
  await decisionHandler({} as never, {} as never, jest.fn());
  expect(
    nativeCompetitionRuntimeService.processDueCompetitions
  ).toHaveBeenCalledTimes(1);
  expect(competitionEventDispatcher.dispatchPending).toHaveBeenCalledTimes(1);
});

it('still drains pending effects when native decision processing fails', async () => {
  const failure = new Error('decision failed');
  jest
    .mocked(nativeCompetitionRuntimeService.processDueCompetitions)
    .mockRejectedValue(failure);
  await expect(
    decisionHandler({} as never, {} as never, jest.fn())
  ).rejects.toBe(failure);
  expect(competitionEventDispatcher.dispatchPending).toHaveBeenCalledTimes(1);
});

it('keeps the leaderboard unit refreshing native leaderboards', async () => {
  await leaderboardHandler({} as never, {} as never, jest.fn());
  expect(
    nativeCompetitionRuntimeService.refreshNativeLeaderboards
  ).toHaveBeenCalledTimes(1);
});
