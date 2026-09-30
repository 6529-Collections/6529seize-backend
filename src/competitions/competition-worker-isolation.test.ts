jest.mock('@/secrets', () => ({
  doInDbContext: (operation: () => Promise<void>) => operation()
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (handler: unknown) => handler
}));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ info: jest.fn() }) }
}));
jest.mock('@/waves/wave-decisions.service', () => ({
  waveDecisionsService: { createMissingDecisionsForAllWaves: jest.fn() }
}));
jest.mock('@/waves/wave-leaderboard-calculation.service', () => ({
  waveLeaderboardCalculationService: {
    refreshLeaderboardEntriesForDropsInNeed: jest.fn()
  }
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
import { waveDecisionsService } from '@/waves/wave-decisions.service';
import { waveLeaderboardCalculationService } from '@/waves/wave-leaderboard-calculation.service';
import { nativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { competitionEventDispatcher } from './competition-event-dispatcher';

const workers = [
  {
    name: 'decisions',
    invoke: decisionHandler as unknown as () => Promise<void>,
    legacy: jest.mocked(waveDecisionsService.createMissingDecisionsForAllWaves),
    native: jest.mocked(nativeCompetitionRuntimeService.processDueCompetitions)
  },
  {
    name: 'leaderboards',
    invoke: leaderboardHandler as unknown as () => Promise<void>,
    legacy: jest.mocked(
      waveLeaderboardCalculationService.refreshLeaderboardEntriesForDropsInNeed
    ),
    native: jest.mocked(
      nativeCompetitionRuntimeService.refreshNativeLeaderboards
    )
  }
];

describe.each(workers)(
  'Main Stage isolation: $name',
  ({ invoke, legacy, native }) => {
    beforeEach(() => {
      jest.resetAllMocks();
      legacy.mockResolvedValue(undefined);
      native.mockResolvedValue(undefined);
    });

    it('finishes legacy work before starting a slow native scan', async () => {
      let finishNative!: () => void;
      let nativeStarted!: () => void;
      const pendingNative = new Promise<void>((resolve) => {
        finishNative = resolve;
      });
      const started = new Promise<void>((resolve) => {
        nativeStarted = resolve;
      });
      const finishedLegacy = jest.fn();
      legacy.mockImplementation(async () => {
        finishedLegacy();
      });
      native.mockImplementation(() => {
        nativeStarted();
        return pendingNative;
      });

      const running = invoke();
      await started;
      try {
        expect(finishedLegacy).toHaveBeenCalledTimes(1);
      } finally {
        finishNative();
        await running;
      }
    });

    it('keeps native processing available after a legacy failure', async () => {
      const failure = new Error('legacy failure');
      legacy.mockRejectedValue(failure);
      await expect(invoke()).rejects.toBe(failure);
      expect(native).toHaveBeenCalledTimes(1);
    });

    it('preserves completed legacy work and reports native failure', async () => {
      const failure = new Error('native failure');
      native.mockRejectedValue(failure);
      await expect(invoke()).rejects.toBe(failure);
      expect(legacy).toHaveBeenCalledTimes(1);
      if (invoke === workers[0].invoke)
        expect(
          competitionEventDispatcher.dispatchPending
        ).toHaveBeenCalledTimes(1);
    });
  }
);
