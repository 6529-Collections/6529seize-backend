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

const competition = (timeLockMs: number | null) =>
  ({
    id: 'competition-1',
    wave_id: 'wave-1',
    type: CompetitionType.RANK,
    lifecycle: 'PUBLISHED',
    decisions: { time_lock_ms: timeLockMs, next_decision_time: 2000 }
  }) as unknown as Competition;

const allowed = {
  isNativeExecutionAllowed: () => true
} as unknown as CompetitionExecutionRouter;

function setUp(marks: string[]) {
  const subject = competition(1000);
  const events: string[] = [];
  const repository = {
    executeNativeQueriesInTransaction: jest.fn(
      async (work: (connection: unknown) => Promise<unknown>) => {
        events.push('begin');
        const result = await work({});
        events.push('commit');
        return result;
      }
    ),
    readCompetition: jest.fn(async () => {
      events.push('read');
      return subject;
    }),
    lockCompetition: jest.fn(async () => {
      events.push('lock');
      return subject;
    }),
    leaderboardInputsMark: jest.fn(async () => {
      const mark = marks.shift() ?? 'unset';
      events.push(`mark:${mark}`);
      return mark;
    })
  };
  const service = new NativeCompetitionRuntimeService(
    repository as unknown as NativeCompetitionRuntimeRepository,
    competitionCreditService,
    allowed
  );
  jest.spyOn(service as any, 'loadState').mockImplementation(async () => {
    events.push('loadState');
    return { entries: [], history: [], pauses: [] };
  });
  jest.spyOn(service as any, 'leaderboardRows').mockImplementation(() => {
    events.push('compute');
    return { rows: [], timeLocked: true };
  });
  const write = jest
    .spyOn(service as any, 'writeLeaderboard')
    .mockImplementation(async () => {
      events.push('write');
    });
  return { service, events, write };
}

describe('refreshLeaderboardOffLock', () => {
  it('computes in its own snapshot and writes under the lock when inputs are unchanged', async () => {
    const { service, events, write } = setUp(['m1', 'm1']);

    await expect(
      service.refreshLeaderboardOffLock(
        'competition-1',
        1500,
        {},
        {
          afterCompute: async () => {
            events.push('hook');
          }
        }
      )
    ).resolves.toBe('written');

    expect(write).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'begin',
      'read',
      'mark:m1',
      'loadState',
      'compute',
      'commit',
      'hook',
      'begin',
      'lock',
      'mark:m1',
      'write',
      'commit'
    ]);
  });

  it('writes nothing when the inputs changed during the computation', async () => {
    const { service, write } = setUp(['m1', 'm2']);

    await expect(
      service.refreshLeaderboardOffLock('competition-1', 1500)
    ).resolves.toBe('changed');

    expect(write).not.toHaveBeenCalled();
  });

  it('refuses to run inside a caller transaction', async () => {
    const { service } = setUp([]);

    await expect(
      service.refreshLeaderboardOffLock('competition-1', 1500, {
        connection: {} as never
      })
    ).rejects.toThrow('cannot join a transaction');
  });
});

describe('refreshLeaderboardForSnapshot', () => {
  function snapshotSetUp(outcome: 'written' | 'changed', timeLockMs = 1000) {
    const subject = competition(timeLockMs);
    const repository = {
      executeNativeQueriesInTransaction: jest.fn(
        async (work: (connection: unknown) => Promise<unknown>) => work({})
      ),
      lockCompetition: jest.fn().mockResolvedValue(subject)
    };
    const service = new NativeCompetitionRuntimeService(
      repository as unknown as NativeCompetitionRuntimeRepository,
      competitionCreditService,
      allowed
    );
    const spies = {
      transitions: jest
        .spyOn(service as any, 'emitScheduledTransitions')
        .mockResolvedValue(undefined),
      reconcile: jest
        .spyOn(service as any, 'reconcileCompetitionCredit')
        .mockResolvedValue(undefined),
      lockedRefresh: jest
        .spyOn(service, 'refreshLeaderboardAfterCreditReconciliation')
        .mockResolvedValue(undefined),
      offLock: jest
        .spyOn(service, 'refreshLeaderboardOffLock')
        .mockImplementation(async (_id, _now, _ctx, _hooks, report) => {
          report?.onMeasured?.({ computeMs: 2_500, writeLockedMs: 30 });
          return outcome;
        }),
      fallback: jest
        .spyOn(service, 'refreshCompetition')
        .mockResolvedValue(undefined)
    };
    return { service, spies };
  }

  it('keeps transitions and credit under the lock and refreshes a time-locked board off it', async () => {
    const { service, spies } = snapshotSetUp('written');

    await service.refreshLeaderboardForSnapshot('competition-1', 1500);

    expect(spies.transitions).toHaveBeenCalledTimes(1);
    expect(spies.reconcile).toHaveBeenCalledTimes(1);
    expect(spies.lockedRefresh).not.toHaveBeenCalled();
    expect(spies.offLock).toHaveBeenCalledTimes(1);
    expect(spies.fallback).not.toHaveBeenCalled();
  });

  it('falls back to the locked refresh when the inputs changed', async () => {
    const { service, spies } = snapshotSetUp('changed');

    await service.refreshLeaderboardForSnapshot('competition-1', 1500);

    expect(spies.fallback).toHaveBeenCalledTimes(1);
  });

  it('refreshes a static board under the lock as before', async () => {
    const { service, spies } = snapshotSetUp('written', 0);

    await service.refreshLeaderboardForSnapshot('competition-1', 1500);

    expect(spies.lockedRefresh).toHaveBeenCalledTimes(1);
    expect(spies.offLock).not.toHaveBeenCalled();
  });

  it.each([
    ['written', 1000, 'off_lock', 2_500],
    ['changed', 1000, 'off_lock_fallback', 2_500],
    ['written', 0, 'locked', 0]
  ] as const)(
    'records one snapshot run per refresh (%s, time lock %i) as %s',
    async (outcome, timeLockMs, path, computeMs) => {
      (recordNativeCompetitionRun as jest.Mock).mockClear();
      const { service } = snapshotSetUp(outcome, timeLockMs);

      await service.refreshLeaderboardForSnapshot('competition-1', 1500);

      expect(recordNativeCompetitionRun).toHaveBeenCalledTimes(1);
      const [record] = (recordNativeCompetitionRun as jest.Mock).mock.calls[0];
      expect(record).toMatchObject({
        competitionId: 'competition-1',
        operation: 'leaderboard',
        path,
        computeMs
      });
      expect(record.lockedMs).toBeGreaterThanOrEqual(
        path.startsWith('off_lock') ? 30 : 0
      );
    }
  );
});
