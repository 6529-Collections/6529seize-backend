import { CompetitionType } from '@/entities/ICompetition';
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

function setUp(subject: Competition, latestDecision: number | null = null) {
  const repository = {
    executeNativeQueriesInTransaction: jest.fn(),
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
  const run = () =>
    service.processCompetition('competition-1', NOW, {
      connection: {} as never
    });
  return { repository, spies, run };
}

describe('waveDecisionExecutionLoop: undue Rank fast path', () => {
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

  it('runs in full for a time-locked Rank, whose standings move with time', async () => {
    const { repository, spies, run } = setUp(
      competition({ time_lock_ms: 24 * HOUR })
    );

    await run();

    expect(repository.decisionProgress).not.toHaveBeenCalled();
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
});
