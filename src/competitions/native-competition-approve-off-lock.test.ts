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

/**
 * Approve competitions take the decision loop's off-lock leaderboard path
 * when no decision is due. "Due" must be exactly when the locked
 * processApprove would write more than the leaderboard (or fail).
 */

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

type Pause = { start_time: number; end_time: number | null };
type Score = {
  entry: { id: string; drop_id: string; submitted_at: number };
  rating: number;
  lastChangedAt: number;
  lastIncreasedAt: number | null;
  overThresholdSince: number | null;
};

function approve(decisions: {
  winning_min_threshold?: number | null;
  winning_threshold_min_duration_ms?: number;
  max_winners?: number | null;
  voting_starts_at?: number | null;
}): Competition {
  return {
    id: 'competition-1',
    wave_id: 'wave-1',
    type: CompetitionType.APPROVE,
    lifecycle: 'PUBLISHED',
    legacy_origin: null,
    voting: { starts_at: decisions.voting_starts_at ?? null },
    decisions: {
      strategy: null,
      next_decision_time: null,
      winning_min_threshold:
        decisions.winning_min_threshold === undefined
          ? 10
          : decisions.winning_min_threshold,
      winning_max_threshold: null,
      winning_threshold_min_duration_ms:
        decisions.winning_threshold_min_duration_ms ?? 0,
      max_winners:
        decisions.max_winners === undefined ? null : decisions.max_winners,
      time_lock_ms: null
    }
  } as unknown as Competition;
}

function score(
  id: string,
  rating: number,
  overThresholdSince: number | null = NOW - HOUR
): Score {
  return {
    entry: { id, drop_id: `drop-${id}`, submitted_at: NOW - 10 * HOUR },
    rating,
    lastChangedAt: NOW - HOUR,
    lastIncreasedAt: NOW - HOUR,
    overThresholdSince
  };
}

function service(completed: number) {
  const repository = {
    decisionProgress: jest.fn().mockResolvedValue({ latest: null, completed })
  };
  const subject = new NativeCompetitionRuntimeService(
    repository as unknown as NativeCompetitionRuntimeRepository,
    competitionCreditService,
    { isNativeExecutionAllowed: () => true } as never
  );
  const writes: string[] = [];
  jest.spyOn(subject as any, 'refreshLeaderboard').mockResolvedValue(undefined);
  jest
    .spyOn(subject as any, 'finalize')
    .mockImplementation(async (...args: unknown[]) => {
      writes.push(`winners:${(args[2] as unknown[]).length}`);
    });
  jest.spyOn(subject as any, 'endCompetition').mockImplementation(async () => {
    writes.push('end');
  });
  return { subject, writes };
}

describe('Approve decisions due off the lock', () => {
  const cases: [
    string,
    Parameters<typeof approve>[0],
    Score[],
    Pause[],
    number,
    boolean
  ][] = [
    ['nothing reaches the threshold', {}, [score('a', 9)], [], 0, false],
    ['an entry reaches the threshold', {}, [score('a', 10)], [], 0, true],
    [
      'voting has not started',
      { voting_starts_at: NOW + 1 },
      [score('a', 50)],
      [],
      0,
      false
    ],
    [
      'the competition is paused',
      {},
      [score('a', 50)],
      [{ start_time: NOW - 1, end_time: null }],
      0,
      false
    ],
    [
      'a pause ended before now',
      {},
      [score('a', 50)],
      [{ start_time: NOW - 2 * HOUR, end_time: NOW - HOUR }],
      0,
      true
    ],
    [
      'an entry has held the threshold for less than the duration',
      { winning_threshold_min_duration_ms: 24 * HOUR },
      [score('a', 50, NOW - HOUR)],
      [],
      0,
      false
    ],
    [
      'an entry has held the threshold for the duration',
      { winning_threshold_min_duration_ms: 24 * HOUR },
      [score('a', 50, NOW - 24 * HOUR)],
      [],
      0,
      true
    ],
    [
      'an entry is over the threshold but never held it',
      { winning_threshold_min_duration_ms: 24 * HOUR },
      [score('a', 50, null)],
      [],
      0,
      false
    ],
    [
      'the winner cap is already reached (the competition ends)',
      { max_winners: 2 },
      [score('a', 1)],
      [],
      2,
      true
    ],
    [
      'the winner cap is reached with eligible entries left',
      { max_winners: 2 },
      [score('a', 50)],
      [],
      2,
      true
    ],
    [
      'the winner cap leaves room and nothing is eligible',
      { max_winners: 2 },
      [score('a', 1)],
      [],
      1,
      false
    ],
    [
      'the threshold is missing (the locked run fails)',
      { winning_min_threshold: null },
      [score('a', 50)],
      [],
      0,
      true
    ]
  ];

  it.each(cases)(
    'agrees with the locked run when %s',
    async (_name, decisions, scores, pauses, completed, expectedDue) => {
      const competition = approve(decisions);
      const state = {
        entries: scores.map((it) => it.entry),
        history: [],
        pauses
      };

      const locked = service(completed);
      jest.spyOn(locked.subject as any, 'scores').mockReturnValue(scores);
      let threw = false;
      try {
        await (locked.subject as any).processApprove(
          competition,
          state,
          NOW,
          {}
        );
      } catch {
        threw = true;
      }
      const lockedWouldWrite = threw || locked.writes.length > 0;

      const offLock = service(completed);
      jest.spyOn(offLock.subject as any, 'scores').mockReturnValue(scores);
      const due = (offLock.subject as any).approveDecisionsDue(
        competition,
        state,
        { latest: null, completed },
        NOW
      );

      expect(due).toBe(lockedWouldWrite);
      expect(due).toBe(expectedDue);
    }
  );
});

describe('waveDecisionExecutionLoop: Approve off the lock', () => {
  function loop(outcome: 'written' | 'decisions_due' | 'changed') {
    const competition = approve({});
    const repository = {
      executeNativeQueriesInTransaction: jest.fn(
        async (work: (connection: unknown) => Promise<unknown>) => work({})
      ),
      lockCompetition: jest.fn().mockResolvedValue(competition),
      decisionProgress: jest
        .fn()
        .mockResolvedValue({ latest: null, completed: 0 })
    };
    const subject = new NativeCompetitionRuntimeService(
      repository as unknown as NativeCompetitionRuntimeRepository,
      competitionCreditService,
      { isNativeExecutionAllowed: () => true } as never
    );
    const spies = {
      reconcile: jest
        .spyOn(subject as any, 'reconcileCompetitionCredit')
        .mockResolvedValue(undefined),
      transitions: jest
        .spyOn(subject as any, 'emitScheduledTransitions')
        .mockResolvedValue(undefined),
      loadState: jest
        .spyOn(subject as any, 'loadState')
        .mockResolvedValue({ entries: [], history: [], pauses: [] }),
      approve: jest
        .spyOn(subject as any, 'processApprove')
        .mockResolvedValue(undefined)
    };
    const offLock = jest
      .spyOn(subject, 'refreshLeaderboardOffLock')
      .mockImplementation(async (_id, _now, _ctx, _hooks, report) => {
        report?.onMeasured?.({ computeMs: 300, writeLockedMs: 20 });
        return outcome;
      });
    return { subject, repository, spies, offLock };
  }

  beforeEach(() => (recordNativeCompetitionRun as jest.Mock).mockClear());

  it('refreshes the leaderboard off the lock when nothing is due', async () => {
    const { subject, spies, offLock } = loop('written');
    await subject.processCompetition('competition-1', NOW);
    // Transitions and credit stay under the lock, before the refresh.
    expect(spies.transitions).toHaveBeenCalledTimes(1);
    expect(spies.reconcile).toHaveBeenCalledTimes(1);
    expect(spies.reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      offLock.mock.invocationCallOrder[0]
    );
    expect(offLock.mock.calls[0][4]).toMatchObject({ operation: 'decisions' });
    expect(spies.loadState).not.toHaveBeenCalled();
    expect(spies.approve).not.toHaveBeenCalled();
    expect(recordNativeCompetitionRun).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'off_lock', computeMs: 300 })
    );
  });

  it.each(['decisions_due', 'changed'] as const)(
    'runs the locked Approve run once when the refresh reports %s',
    async (outcome) => {
      const { subject, spies, repository, offLock } = loop(outcome);
      await subject.processCompetition('competition-1', NOW);
      expect(spies.approve).toHaveBeenCalledTimes(1);
      expect(spies.reconcile).toHaveBeenCalledTimes(2);
      expect(repository.lockCompetition).toHaveBeenCalledTimes(2);
      // A due decision goes to the locked run at once; changed inputs are
      // retried off the lock first.
      const attempts = outcome === 'decisions_due' ? 1 : 3;
      expect(offLock).toHaveBeenCalledTimes(attempts);
      expect(recordNativeCompetitionRun).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'off_lock_fallback', attempts })
      );
    }
  );

  it('runs Approve in full inside a caller transaction', async () => {
    const { subject, spies, offLock } = loop('written');
    await subject.processCompetition('competition-1', NOW, {
      connection: {} as never
    });
    expect(offLock).not.toHaveBeenCalled();
    expect(spies.approve).toHaveBeenCalledTimes(1);
  });
});

describe('refreshLeaderboardOffLock for Approve', () => {
  function refresh(due: boolean) {
    const competition = approve({});
    const transactions: string[] = [];
    const repository = {
      executeNativeQueriesInTransaction: jest.fn(
        async (work: (connection: unknown) => Promise<unknown>) => {
          transactions.push('begin');
          return work({});
        }
      ),
      readCompetition: jest.fn().mockResolvedValue(competition),
      lockCompetition: jest.fn().mockResolvedValue(competition),
      leaderboardInputsMark: jest.fn().mockResolvedValue('mark'),
      decisionProgress: jest
        .fn()
        .mockResolvedValue({ latest: null, completed: 0 })
    };
    const subject = new NativeCompetitionRuntimeService(
      repository as unknown as NativeCompetitionRuntimeRepository,
      competitionCreditService,
      { isNativeExecutionAllowed: () => true } as never
    );
    jest
      .spyOn(subject as any, 'loadState')
      .mockResolvedValue({ entries: [], history: [], pauses: [] });
    jest
      .spyOn(subject as any, 'leaderboardRows')
      .mockReturnValue({ rows: [], timeLocked: false });
    const decided = jest
      .spyOn(subject as any, 'approveDecisionsDue')
      .mockReturnValue(due);
    const write = jest
      .spyOn(subject as any, 'writeLeaderboard')
      .mockResolvedValue(undefined);
    return { subject, repository, transactions, decided, write };
  }

  it('reports a due decision without taking the lock or writing', async () => {
    const { subject, repository, transactions, write } = refresh(true);
    const measured = jest.fn();
    await expect(
      subject.refreshLeaderboardOffLock(
        'competition-1',
        NOW,
        {},
        {},
        { operation: 'decisions', onMeasured: measured }
      )
    ).resolves.toBe('decisions_due');
    expect(transactions).toEqual(['begin']);
    expect(repository.lockCompetition).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(measured).toHaveBeenCalledWith(
      expect.objectContaining({ writeLockedMs: 0 })
    );
  });

  it('writes the leaderboard under the lock when no decision is due', async () => {
    const { subject, repository, write } = refresh(false);
    await expect(
      subject.refreshLeaderboardOffLock(
        'competition-1',
        NOW,
        {},
        {},
        { operation: 'decisions' }
      )
    ).resolves.toBe('written');
    // Read in the snapshot, and again under the lock before writing.
    expect(repository.decisionProgress).toHaveBeenCalledTimes(2);
    expect(repository.lockCompetition).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when a decision completed between the snapshot and the lock', async () => {
    const { subject, repository, write } = refresh(false);
    repository.decisionProgress
      .mockResolvedValueOnce({ latest: null, completed: 0 })
      .mockResolvedValueOnce({ latest: NOW - 1, completed: 1 });
    await expect(
      subject.refreshLeaderboardOffLock(
        'competition-1',
        NOW,
        {},
        {},
        { operation: 'decisions' }
      )
    ).resolves.toBe('changed');
    expect(write).not.toHaveBeenCalled();
  });

  it('does not look for decisions when the snapshotter refreshes', async () => {
    const { subject, repository, decided, write } = refresh(true);
    await expect(
      subject.refreshLeaderboardOffLock('competition-1', NOW)
    ).resolves.toBe('written');
    expect(repository.decisionProgress).not.toHaveBeenCalled();
    expect(decided).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
