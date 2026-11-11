jest.mock('@/competitions/competition-tdh-overvotes.db', () => ({
  competitionTdhOvervotesDb: { findOvervoters: jest.fn() }
}));
jest.mock('@/competitions/native-competition-runtime.repository', () => ({
  nativeCompetitionRuntimeRepository: {
    findOvervoteCandidateCompetitions: jest.fn(),
    readCompetition: jest.fn(),
    lockCompetition: jest.fn(),
    listActiveVoters: jest.fn(),
    getVoterActiveVotes: jest.fn()
  }
}));
jest.mock('@/competitions/native-competition-runtime.service', () => ({
  nativeCompetitionRuntimeService: {
    reconcileVoterCredit: jest.fn(),
    refreshCompetition: jest.fn(),
    enqueueDueTransitions: jest.fn(),
    refreshLeaderboardAfterCreditReconciliation: jest.fn()
  }
}));
jest.mock('@/competitions/competition-credit.service', () => ({
  competitionCreditService: { getBudget: jest.fn() }
}));
jest.mock('@/competitions/competition.repository', () => ({
  competitionRepository: { findNativeEntry: jest.fn() }
}));
jest.mock('@/competitions/competition-drop-votes.db', () => ({
  competitionDropVotesDb: { totals: jest.fn() }
}));
jest.mock('@/api/waves/waves.api.db', () => ({
  wavesApiDb: { findById: jest.fn() }
}));
jest.mock('@/notifications/user.notifier', () => ({
  userNotifier: { notifyOfDropVote: jest.fn() }
}));
jest.mock('@/app-features', () => ({
  appFeatures: { isDropOvervoteRevocationEnabled: () => true }
}));

import {
  revokeRepBasedDropOverVotes,
  revokeTdhBasedDropWavesOverVotes,
  revokeTdhBasedDropWavesOverVotesPerCompetition
} from './participation-drops-over-vote-revocation';
import { ConnectionWrapper, setSqlExecutor } from '@/sql-executor';
import { nativeCompetitionRuntimeRepository as runtime } from '@/competitions/native-competition-runtime.repository';
import { nativeCompetitionRuntimeService as service } from '@/competitions/native-competition-runtime.service';
import { competitionCreditService as credits } from '@/competitions/competition-credit.service';
import { competitionRepository as repository } from '@/competitions/competition.repository';
import { competitionDropVotesDb as votes } from '@/competitions/competition-drop-votes.db';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { userNotifier } from '@/notifications/user.notifier';
import { competitionTdhOvervotesDb } from '@/competitions/competition-tdh-overvotes.db';

const connection = {} as never;
const competition = {
  id: 'native-competition',
  wave_id: 'hub',
  execution_mode: 'ACTIVE',
  lifecycle: 'PUBLISHED',
  voting: {
    credit_type: 'TDH',
    credit_scope: 'WAVE',
    credit_category: null,
    credit_creditor: null
  }
};

beforeEach(() => {
  jest.resetAllMocks();
  jest
    .mocked(runtime.findOvervoteCandidateCompetitions)
    .mockResolvedValueOnce([competition.id])
    .mockResolvedValue([]);
  jest.mocked(runtime.readCompetition).mockResolvedValue(competition as never);
  jest.mocked(runtime.lockCompetition).mockResolvedValue(competition as never);
  jest
    .mocked(competitionTdhOvervotesDb.findOvervoters)
    .mockResolvedValue(['voter']);
  jest
    .mocked(runtime.getVoterActiveVotes)
    .mockResolvedValueOnce([{ entryId: 'entry', value: -10 }])
    .mockResolvedValue([{ entryId: 'entry', value: -5 }]);
  jest.mocked(credits.getBudget).mockResolvedValue({ available: 5 } as never);
  jest.mocked(repository.findNativeEntry).mockResolvedValue({
    id: 'entry',
    drop_id: 'drop',
    submitter_id: 'author'
  } as never);
  jest.mocked(votes.totals).mockResolvedValue({ total: -5 } as never);
  jest
    .mocked(wavesApiDb.findById)
    .mockResolvedValue({ visibility_group_id: 'visible' } as never);
});

it('reconciles native TDH votes in the existing transaction and preserves notification values', async () => {
  await revokeTdhBasedDropWavesOverVotes(connection);
  expect(service.reconcileVoterCredit).toHaveBeenCalledWith(
    expect.objectContaining({
      competitionId: competition.id,
      voterProfileId: 'voter',
      availableCredit: 5,
      creditScope: 'WAVE'
    }),
    expect.objectContaining({ connection })
  );
  expect(userNotifier.notifyOfDropVote).toHaveBeenCalledWith(
    expect.objectContaining({
      drop_id: 'drop',
      vote: -5,
      vote_change: 5,
      total_vote: -5
    }),
    'visible',
    connection
  );
  expect(
    service.refreshLeaderboardAfterCreditReconciliation
  ).toHaveBeenCalledWith(
    competition,
    expect.any(Number),
    expect.objectContaining({ connection })
  );
});

it('does not execute disabled competitions', async () => {
  jest
    .mocked(runtime.lockCompetition)
    .mockResolvedValue({ ...competition, execution_mode: 'DISABLED' } as never);
  await revokeTdhBasedDropWavesOverVotes(connection);
  expect(service.reconcileVoterCredit).not.toHaveBeenCalled();
});

it('reads TDH candidates without a voter and locks only candidates', async () => {
  await revokeTdhBasedDropWavesOverVotes(connection);
  expect(runtime.findOvervoteCandidateCompetitions).toHaveBeenNthCalledWith(
    1,
    '',
    100,
    null,
    expect.objectContaining({ connection })
  );
  expect(runtime.findOvervoteCandidateCompetitions).toHaveBeenNthCalledWith(
    2,
    competition.id,
    100,
    null,
    expect.objectContaining({ connection })
  );
  expect(runtime.lockCompetition).toHaveBeenCalledTimes(1);
  expect(runtime.lockCompetition).toHaveBeenCalledWith(
    competition.id,
    expect.objectContaining({ connection })
  );
  expect(
    jest.mocked(runtime.readCompetition).mock.invocationCallOrder[0]
  ).toBeLessThan(
    jest.mocked(runtime.lockCompetition).mock.invocationCallOrder[0]
  );
});

it('never locks a candidate whose unlocked configuration does not apply', async () => {
  jest.mocked(runtime.readCompetition).mockResolvedValue({
    ...competition,
    voting: { ...competition.voting, credit_type: 'REP' }
  } as never);
  await revokeTdhBasedDropWavesOverVotes(connection);
  expect(runtime.lockCompetition).not.toHaveBeenCalled();
  expect(service.reconcileVoterCredit).not.toHaveBeenCalled();
});

it('never locks a candidate that is no longer active and published', async () => {
  jest
    .mocked(runtime.readCompetition)
    .mockResolvedValue({ ...competition, lifecycle: 'DRAFT' } as never);
  await revokeTdhBasedDropWavesOverVotes(connection);
  expect(runtime.lockCompetition).not.toHaveBeenCalled();
});

it('re-checks the configuration under the lock', async () => {
  jest.mocked(runtime.lockCompetition).mockResolvedValue({
    ...competition,
    voting: { ...competition.voting, credit_type: 'REP' }
  } as never);
  await revokeTdhBasedDropWavesOverVotes(connection);
  expect(runtime.lockCompetition).toHaveBeenCalledTimes(1);
  expect(competitionTdhOvervotesDb.findOvervoters).not.toHaveBeenCalled();
  expect(service.reconcileVoterCredit).not.toHaveBeenCalled();
});

it('revokes after a sync in one transaction per candidate competition', async () => {
  jest
    .mocked(runtime.findOvervoteCandidateCompetitions)
    .mockReset()
    .mockResolvedValueOnce(['first', 'second', 'rep'])
    .mockResolvedValue([]);
  jest.mocked(runtime.readCompetition).mockImplementation(
    async (id) =>
      (id === 'rep'
        ? {
            ...competition,
            id,
            voting: { ...competition.voting, credit_type: 'REP' }
          }
        : { ...competition, id }) as never
  );
  jest
    .mocked(runtime.lockCompetition)
    .mockImplementation(async (id) => ({ ...competition, id }) as never);
  jest.mocked(competitionTdhOvervotesDb.findOvervoters).mockResolvedValue([]);
  const transactions: ConnectionWrapper<unknown>[] = [];
  setSqlExecutor({
    executeNativeQueriesInTransaction: async <T>(
      executable: (connection: ConnectionWrapper<unknown>) => Promise<T>
    ) => {
      const connection = { connection: { transaction: transactions.length } };
      transactions.push(connection);
      return executable(connection);
    }
  } as never);

  await expect(
    revokeTdhBasedDropWavesOverVotesPerCompetition()
  ).resolves.toMatchObject({ candidates: 3 });

  // Candidates are read outside any transaction; each competition gets its own.
  expect(runtime.findOvervoteCandidateCompetitions).toHaveBeenCalledWith(
    '',
    100,
    null,
    {}
  );
  expect(transactions).toHaveLength(3);
  expect(jest.mocked(runtime.lockCompetition).mock.calls).toEqual([
    ['first', expect.objectContaining({ connection: transactions[0] })],
    ['second', expect.objectContaining({ connection: transactions[1] })]
  ]);
});

function inOwnTransactions(): ConnectionWrapper<unknown>[] {
  const transactions: ConnectionWrapper<unknown>[] = [];
  setSqlExecutor({
    executeNativeQueriesInTransaction: async <T>(
      executable: (connection: ConnectionWrapper<unknown>) => Promise<T>
    ) => {
      const connection = { connection: { transaction: transactions.length } };
      transactions.push(connection);
      return executable(connection);
    }
  } as never);
  return transactions;
}

function candidates(ids: string[]) {
  jest
    .mocked(runtime.findOvervoteCandidateCompetitions)
    .mockReset()
    .mockResolvedValueOnce(ids)
    .mockResolvedValue([]);
  jest
    .mocked(runtime.readCompetition)
    .mockImplementation(async (id) => ({ ...competition, id }) as never);
  jest.mocked(competitionTdhOvervotesDb.findOvervoters).mockResolvedValue([]);
}

it('skips a busy competition after a sync, revokes the others and reports it', async () => {
  candidates(['first', 'busy', 'third']);
  jest.mocked(runtime.lockCompetition).mockImplementation(async (id) => {
    if (id === 'busy')
      throw Object.assign(new Error('Lock wait timeout exceeded'), {
        code: 'ER_LOCK_WAIT_TIMEOUT'
      });
    return { ...competition, id } as never;
  });
  inOwnTransactions();

  await expect(
    revokeTdhBasedDropWavesOverVotesPerCompetition()
  ).resolves.toMatchObject({ candidates: 3, failed: 1 });

  expect(
    jest
      .mocked(competitionTdhOvervotesDb.findOvervoters)
      .mock.calls.map(([locked]) => locked.id)
  ).toEqual(['first', 'third']);
});

it('fails the step on an error other than a lock wait or deadlock', async () => {
  candidates(['first', 'broken', 'third']);
  jest.mocked(runtime.lockCompetition).mockImplementation(async (id) => {
    if (id === 'broken') throw new Error('bad competition config');
    return { ...competition, id } as never;
  });
  inOwnTransactions();

  await expect(
    revokeTdhBasedDropWavesOverVotesPerCompetition()
  ).rejects.toThrow('bad competition config');
  expect(runtime.lockCompetition).not.toHaveBeenCalledWith(
    'third',
    expect.anything()
  );
});

it('reads REP candidates by the rating recipient', async () => {
  const repCompetition = {
    ...competition,
    voting: { ...competition.voting, credit_type: 'REP' }
  };
  jest
    .mocked(runtime.readCompetition)
    .mockResolvedValue(repCompetition as never);
  jest
    .mocked(runtime.lockCompetition)
    .mockResolvedValue(repCompetition as never);
  await revokeRepBasedDropOverVotes(
    {
      rep_recipient_id: 'voter',
      rep_giver_id: 'creditor',
      credit_category: 'art'
    },
    connection
  );
  expect(runtime.findOvervoteCandidateCompetitions).toHaveBeenCalledWith(
    '',
    100,
    'voter',
    expect.objectContaining({ connection })
  );
  expect(service.reconcileVoterCredit).toHaveBeenCalledWith(
    expect.objectContaining({ voterProfileId: 'voter' }),
    expect.objectContaining({ connection })
  );
  expect(service.refreshCompetition).toHaveBeenCalledTimes(1);
});

it('limits REP reconciliation to affected native credit namespaces', async () => {
  const repCompetition = {
    ...competition,
    voting: {
      ...competition.voting,
      credit_type: 'REP',
      credit_category: 'art',
      credit_creditor: 'creditor'
    }
  };
  jest
    .mocked(runtime.readCompetition)
    .mockResolvedValue(repCompetition as never);
  jest
    .mocked(runtime.lockCompetition)
    .mockResolvedValue(repCompetition as never);
  await revokeRepBasedDropOverVotes(
    {
      rep_recipient_id: 'voter',
      rep_giver_id: 'different-creditor',
      credit_category: 'art'
    },
    connection
  );
  expect(runtime.lockCompetition).not.toHaveBeenCalled();
  expect(service.reconcileVoterCredit).not.toHaveBeenCalled();
});

it('does not read voters or rebuild a fully funded competition', async () => {
  jest.mocked(competitionTdhOvervotesDb.findOvervoters).mockResolvedValue([]);
  await revokeTdhBasedDropWavesOverVotes(connection);
  expect(runtime.listActiveVoters).not.toHaveBeenCalled();
  expect(runtime.getVoterActiveVotes).not.toHaveBeenCalled();
  expect(credits.getBudget).not.toHaveBeenCalled();
  expect(service.refreshCompetition).not.toHaveBeenCalled();
  expect(
    service.refreshLeaderboardAfterCreditReconciliation
  ).not.toHaveBeenCalled();
});

it('notifies every reduced voter before one leaderboard refresh without reconciling the whole competition again', async () => {
  jest
    .mocked(competitionTdhOvervotesDb.findOvervoters)
    .mockResolvedValue(['first', 'second']);
  jest.mocked(runtime.getVoterActiveVotes).mockReset();
  jest
    .mocked(runtime.getVoterActiveVotes)
    .mockResolvedValueOnce([{ entryId: 'entry', value: -10 }])
    .mockResolvedValueOnce([{ entryId: 'entry', value: -5 }])
    .mockResolvedValueOnce([{ entryId: 'entry', value: 20 }])
    .mockResolvedValueOnce([{ entryId: 'entry', value: 5 }]);
  await revokeTdhBasedDropWavesOverVotes(connection);
  expect(service.reconcileVoterCredit).toHaveBeenCalledTimes(2);
  expect(userNotifier.notifyOfDropVote).toHaveBeenCalledTimes(2);
  expect(userNotifier.notifyOfDropVote).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ voter_id: 'second', vote: 5, vote_change: -15 }),
    'visible',
    connection
  );
  expect(service.refreshCompetition).not.toHaveBeenCalled();
  expect(
    service.refreshLeaderboardAfterCreditReconciliation
  ).toHaveBeenCalledTimes(1);
  expect(service.enqueueDueTransitions).toHaveBeenCalledTimes(1);
  expect(
    jest.mocked(service.refreshLeaderboardAfterCreditReconciliation).mock
      .invocationCallOrder[0]
  ).toBeGreaterThan(
    jest.mocked(userNotifier.notifyOfDropVote).mock.invocationCallOrder[1]
  );
});

it('does not refresh a candidate whose authoritative budget no longer needs a reduction', async () => {
  jest.mocked(runtime.getVoterActiveVotes).mockReset();
  jest
    .mocked(runtime.getVoterActiveVotes)
    .mockResolvedValue([{ entryId: 'entry', value: 5 }]);
  await revokeTdhBasedDropWavesOverVotes(connection);
  expect(userNotifier.notifyOfDropVote).not.toHaveBeenCalled();
  expect(
    service.refreshLeaderboardAfterCreditReconciliation
  ).not.toHaveBeenCalled();
});
