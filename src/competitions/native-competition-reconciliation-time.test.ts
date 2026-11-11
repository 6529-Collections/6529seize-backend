import { NativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { NativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { CompetitionExecutionRouter } from './competition-execution.router';
import { flooredWeightedNativeVote } from './native-competition-runtime.helpers';
import { WaveCreditScope } from '@/entities/IWave';

const PASS_TIME = 500;
const competition = {
  id: 'competition',
  voting: { credit_scope: WaveCreditScope.WAVE }
};

function setUp(latestHistoryTime: number | null) {
  const writes: { kind: string; entryId: string; occurredAt: number }[] = [];
  const repository = {
    listActiveVoters: jest.fn().mockResolvedValue(['voter']),
    getVoterActiveVotes: jest
      .fn()
      .mockResolvedValue([{ entryId: 'entry', value: 80 }]),
    latestEntryHistoryTime: jest.fn().mockResolvedValue(latestHistoryTime),
    replaceVoteForReconciliation: jest.fn(async (mutation) => {
      writes.push({ kind: 'vote', ...mutation });
    }),
    recordVoteChange: jest.fn(async (change) => {
      writes.push({ kind: 'history', ...change });
    })
  };
  const credits = {
    getBudget: jest.fn(),
    getWaveBudgets: jest
      .fn()
      .mockResolvedValue(new Map([['voter', { available: 50, spent: 80 }]])),
    getDropBudgets: jest.fn()
  };
  const service = new NativeCompetitionRuntimeService(
    repository as unknown as NativeCompetitionRuntimeRepository,
    credits as never,
    new CompetitionExecutionRouter()
  );
  const reconcilePass = () =>
    (
      service as unknown as {
        reconcileCompetitionCredit(
          competition: unknown,
          now: number,
          ctx: unknown
        ): Promise<void>;
      }
    ).reconcileCompetitionCredit(competition, PASS_TIME, { connection: {} });
  return { service, repository, writes, reconcilePass };
}

describe('credit reconciliation history time', () => {
  it('stamps a pass reconciliation no earlier than a vote written since the pass started', async () => {
    const { repository, writes, reconcilePass } = setUp(700);

    await reconcilePass();

    expect(repository.latestEntryHistoryTime).toHaveBeenCalledWith(
      'competition',
      'entry',
      { connection: {} }
    );
    expect(writes).toEqual([
      expect.objectContaining({ kind: 'vote', value: 50, occurredAt: 700 }),
      expect.objectContaining({
        kind: 'history',
        value: 50,
        previousVote: 80,
        occurredAt: 700,
        reason: 'CREDIT_OVERSPENT'
      })
    ]);
  });

  it.each([
    ['older history', 400],
    ['no history', null]
  ])('keeps the pass time with %s', async (_, latest) => {
    const { writes, reconcilePass } = setUp(latest);

    await reconcilePass();

    expect(writes.map((write) => write.occurredAt)).toEqual([
      PASS_TIME,
      PASS_TIME
    ]);
  });

  it('reads no history for callers that take their time under the lock', async () => {
    const { service, repository, writes } = setUp(700);

    await service.reconcileVoterCredit(
      {
        competitionId: 'competition',
        voterProfileId: 'voter',
        availableCredit: 50,
        creditScope: WaveCreditScope.WAVE,
        occurredAt: 650
      },
      { connection: {} as never }
    );

    expect(repository.latestEntryHistoryTime).not.toHaveBeenCalled();
    expect(writes.map((write) => write.occurredAt)).toEqual([650, 650]);
  });

  it('lets the reconciled aggregate, not the earlier vote, be the latest score', () => {
    // A vote at 700 raised the aggregate to 80; the pass that started at
    // 500 then reduced it to 50 with a later mutation sequence.
    const vote = { timestamp: 700, vote: 80, sequence: 11 };
    const passTimeStamp = { timestamp: PASS_TIME, vote: 50, sequence: 12 };
    const historyTimeStamp = { timestamp: 700, vote: 50, sequence: 12 };

    expect(flooredWeightedNativeVote([vote, passTimeStamp], 1000, 0)).toBe(80);
    expect(flooredWeightedNativeVote([vote, historyTimeStamp], 1000, 0)).toBe(
      50
    );
  });
});
