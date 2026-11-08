jest.mock('./native-competition-metrics', () => ({
  recordNativeCompetitionRun: jest.fn()
}));

import { CompetitionType } from '@/entities/ICompetition';
import { recordNativeCompetitionRun } from './native-competition-metrics';
import { Competition } from './competition.types';
import { NativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { NativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { competitionCreditService } from './competition-credit.service';
import { CompetitionExecutionRouter } from './competition-execution.router';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function competition(overrides: {
  type?: CompetitionType;
  time_lock_ms?: number | null;
  next_decision_time?: number | null;
  first_decision_time?: number;
}): Competition {
  const first = overrides.first_decision_time ?? NOW + HOUR;
  return {
    id: 'competition-1',
    wave_id: 'wave-1',
    type: overrides.type ?? CompetitionType.RANK,
    lifecycle: 'PUBLISHED',
    decisions: {
      strategy: {
        first_decision_time: first,
        subsequent_decisions: [HOUR],
        is_rolling: true
      },
      next_decision_time:
        overrides.next_decision_time === undefined
          ? first
          : overrides.next_decision_time,
      winning_min_threshold: null,
      winning_max_threshold: null,
      winning_threshold_min_duration_ms: 0,
      max_winners: 1,
      time_lock_ms: overrides.time_lock_ms ?? null
    }
  } as unknown as Competition;
}

function setUp(
  subject: Competition,
  latestDecision: number | null = null,
  offLockOutcome: 'written' | 'changed' = 'written'
) {
  const repository = {
    executeNativeQueriesInTransaction: jest.fn(
      async (work: (connection: unknown) => Promise<unknown>) => work({})
    ),
    lockCompetition: jest.fn().mockResolvedValue(subject),
    decisionProgress: jest
      .fn()
      .mockResolvedValue({ latest: latestDecision, completed: 0 })
  };
  const router = {
    isNativeExecutionAllowed: jest.fn().mockReturnValue(true)
  };
  const service = new NativeCompetitionRuntimeService(
    repository as unknown as NativeCompetitionRuntimeRepository,
    competitionCreditService,
    router as unknown as CompetitionExecutionRouter
  );
  const spies = {
    transitions: jest
      .spyOn(service as any, 'emitScheduledTransitions')
      .mockResolvedValue(undefined),
    reconcile: jest
      .spyOn(service as any, 'reconcileCompetitionCredit')
      .mockResolvedValue(undefined),
    loadState: jest
      .spyOn(service as any, 'loadState')
      .mockResolvedValue({ entries: [], history: [], pauses: [] }),
    rank: jest
      .spyOn(service as any, 'processRank')
      .mockResolvedValue(undefined),
    approve: jest
      .spyOn(service as any, 'processApprove')
      .mockResolvedValue(undefined)
  };
  const offLock = jest
    .spyOn(service, 'refreshLeaderboardOffLock')
    .mockImplementation(async (_id, _now, _ctx, _hooks, report) => {
      report?.onMeasured?.({ computeMs: 3_000, writeLockedMs: 40 });
      return offLockOutcome;
    });
  const run = () =>
    service.processCompetition('competition-1', NOW, {
      connection: {} as never
    });
  // The decision loop calls without a transaction.
  const runFromLoop = () => service.processCompetition('competition-1', NOW);
  return { repository, spies, offLock, run, runFromLoop };
}

describe('waveDecisionExecutionLoop: undue Rank fast path', () => {
  beforeEach(() => (recordNativeCompetitionRun as jest.Mock).mockClear());

  const recorded = () =>
    (recordNativeCompetitionRun as jest.Mock).mock.calls.map(([it]) => it);

  it.each([
    ['a static undue Rank', {}, 'written', 'static', 0],
    [
      'an undue time-locked Rank',
      { time_lock_ms: 24 * HOUR },
      'written',
      'off_lock',
      3_000
    ],
    [
      'an undue time-locked Rank whose inputs changed',
      { time_lock_ms: 24 * HOUR },
      'changed',
      'off_lock_fallback',
      3_000
    ],
    [
      'a due Rank',
      { first_decision_time: NOW - 1, next_decision_time: NOW - 1 },
      'written',
      'locked',
      0
    ]
  ] as const)(
    'records the decision path of %s with its row-lock time',
    async (_name, overrides, outcome, path, computeMs) => {
      const { runFromLoop } = setUp(competition(overrides), null, outcome);

      await runFromLoop();

      expect(recorded()).toEqual([
        expect.objectContaining({
          competitionId: 'competition-1',
          operation: 'decisions',
          path,
          computeMs
        })
      ]);
      const [{ lockedMs, durationMs }] = recorded();
      expect(lockedMs).toBeGreaterThanOrEqual(
        path.startsWith('off_lock') ? 40 : 0
      );
      expect(durationMs).toBeGreaterThanOrEqual(0);
    }
  );

  it('records nothing for a run inside a caller transaction', async () => {
    const { run } = setUp(competition({ time_lock_ms: 24 * HOUR }));

    await run();

    expect(recordNativeCompetitionRun).not.toHaveBeenCalled();
  });

  it('skips credit, state and leaderboard work for a static Rank with nothing due', async () => {
    const { repository, spies, run } = setUp(competition({}));

    await run();

    expect(repository.lockCompetition).toHaveBeenCalledTimes(1);
    expect(spies.transitions).toHaveBeenCalledTimes(1);
    expect(repository.decisionProgress).toHaveBeenCalledTimes(1);
    expect(spies.reconcile).not.toHaveBeenCalled();
    expect(spies.loadState).not.toHaveBeenCalled();
    expect(spies.rank).not.toHaveBeenCalled();
  });

  it('runs in full when a decision is due', async () => {
    const { spies, run } = setUp(
      competition({ first_decision_time: NOW - 1, next_decision_time: NOW - 1 })
    );

    await run();

    expect(spies.reconcile).toHaveBeenCalledTimes(1);
    expect(spies.loadState).toHaveBeenCalledTimes(1);
    expect(spies.rank).toHaveBeenCalledTimes(1);
  });

  it('runs a time-locked Rank in full inside a caller transaction', async () => {
    const { spies, run } = setUp(competition({ time_lock_ms: 24 * HOUR }));

    await run();

    expect(spies.reconcile).toHaveBeenCalledTimes(1);
    expect(spies.rank).toHaveBeenCalledTimes(1);
  });

  it('runs in full when the stored next decision time is stale', async () => {
    const { spies, run } = setUp(
      competition({ next_decision_time: NOW - 5 * HOUR })
    );

    await run();

    expect(spies.rank).toHaveBeenCalledTimes(1);
  });

  it('runs in full when the schedule has no next decision (ending)', async () => {
    const subject = competition({ first_decision_time: NOW - HOUR });
    const noFurther = {
      ...subject,
      decisions: {
        ...subject.decisions,
        strategy: {
          first_decision_time: NOW - HOUR,
          subsequent_decisions: [],
          is_rolling: false
        }
      }
    } as Competition;
    const { spies, run } = setUp(noFurther, NOW - HOUR);

    await run();

    expect(spies.rank).toHaveBeenCalledTimes(1);
  });

  it('runs Approve competitions in full', async () => {
    const { repository, spies, run } = setUp(
      competition({ type: CompetitionType.APPROVE })
    );

    await run();

    expect(repository.decisionProgress).not.toHaveBeenCalled();
    expect(spies.approve).toHaveBeenCalledTimes(1);
  });

  it('refreshes an undue time-locked Rank off the lock from the loop', async () => {
    const { repository, spies, offLock, runFromLoop } = setUp(
      competition({ time_lock_ms: 24 * HOUR })
    );

    await runFromLoop();

    expect(spies.transitions).toHaveBeenCalledTimes(1);
    // Credit is still reconciled under the lock, before the off-lock refresh.
    expect(spies.reconcile).toHaveBeenCalledTimes(1);
    expect(spies.reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      offLock.mock.invocationCallOrder[0]
    );
    expect(spies.loadState).not.toHaveBeenCalled();
    expect(spies.rank).not.toHaveBeenCalled();
    expect(offLock).toHaveBeenCalledTimes(1);
    expect(offLock.mock.calls[0][0]).toBe('competition-1');
    expect(repository.executeNativeQueriesInTransaction).toHaveBeenCalledTimes(
      1
    );
  });

  it('runs the locked decision run once when the inputs changed off the lock', async () => {
    const { repository, spies, offLock, runFromLoop } = setUp(
      competition({ time_lock_ms: 24 * HOUR }),
      null,
      'changed'
    );

    await runFromLoop();

    expect(offLock).toHaveBeenCalledTimes(1);
    expect(repository.executeNativeQueriesInTransaction).toHaveBeenCalledTimes(
      2
    );
    expect(repository.lockCompetition).toHaveBeenCalledTimes(2);
    // The fallback is the full run, as before the off-lock path.
    expect(spies.reconcile).toHaveBeenCalledTimes(2);
    expect(spies.loadState).toHaveBeenCalledTimes(1);
    expect(spies.rank).toHaveBeenCalledTimes(1);
    expect(spies.rank.mock.invocationCallOrder[0]).toBeGreaterThan(
      offLock.mock.invocationCallOrder[0]
    );
  });

  it('does not refresh a static undue Rank at all from the loop', async () => {
    const { spies, offLock, runFromLoop } = setUp(competition({}));

    await runFromLoop();

    expect(spies.rank).not.toHaveBeenCalled();
    expect(offLock).not.toHaveBeenCalled();
  });

  it('decides a due time-locked Rank under the lock, not off it', async () => {
    const { spies, offLock, runFromLoop } = setUp(
      competition({
        time_lock_ms: 24 * HOUR,
        first_decision_time: NOW - 1,
        next_decision_time: NOW - 1
      })
    );

    await runFromLoop();

    expect(spies.reconcile).toHaveBeenCalledTimes(1);
    expect(spies.rank).toHaveBeenCalledTimes(1);
    expect(offLock).not.toHaveBeenCalled();
  });
});
