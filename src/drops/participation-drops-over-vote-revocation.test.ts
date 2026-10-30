jest.mock('@/competitions/competition-tdh-overvotes.db', () => ({
  competitionTdhOvervotesDb: { findOvervoters: jest.fn() }
}));
jest.mock('@/competitions/native-competition-runtime.repository', () => ({
  nativeCompetitionRuntimeRepository: {
    discoverCompetitions: jest.fn(),
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
  revokeTdhBasedDropWavesOverVotes
} from './participation-drops-over-vote-revocation';
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
    .mocked(runtime.discoverCompetitions)
    .mockResolvedValueOnce([competition.id])
    .mockResolvedValue([]);
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

it('limits REP reconciliation to affected native credit namespaces', async () => {
  jest.mocked(runtime.lockCompetition).mockResolvedValue({
    ...competition,
    voting: {
      ...competition.voting,
      credit_type: 'REP',
      credit_category: 'art',
      credit_creditor: 'creditor'
    }
  } as never);
  await revokeRepBasedDropOverVotes(
    {
      rep_recipient_id: 'voter',
      rep_giver_id: 'different-creditor',
      credit_category: 'art'
    },
    connection
  );
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
