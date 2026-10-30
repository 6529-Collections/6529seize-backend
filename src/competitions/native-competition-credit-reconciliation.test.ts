import { NativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { NativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { competitionCreditService } from './competition-credit.service';
import { competitionExecutionRouter } from './competition-execution.router';

it.each(['WAVE', 'DROP'])(
  'does not write votes, history or outbox effects for a funded %s voter',
  async (creditScope) => {
    const repository = {
      getVoterActiveVotes: jest.fn().mockResolvedValue([
        { entryId: 'one', value: -5 },
        { entryId: 'two', value: 5 }
      ]),
      replaceVoteForReconciliation: jest.fn(),
      recordVoteChange: jest.fn()
    };
    const service = new NativeCompetitionRuntimeService(
      repository as unknown as NativeCompetitionRuntimeRepository,
      competitionCreditService,
      competitionExecutionRouter
    );
    await service.reconcileVoterCredit(
      {
        competitionId: 'competition',
        voterProfileId: 'funded',
        availableCredit: creditScope === 'WAVE' ? 10 : 5,
        creditScope,
        occurredAt: 1
      },
      { connection: {} as never }
    );
    expect(repository.replaceVoteForReconciliation).not.toHaveBeenCalled();
    expect(repository.recordVoteChange).not.toHaveBeenCalled();
  }
);
