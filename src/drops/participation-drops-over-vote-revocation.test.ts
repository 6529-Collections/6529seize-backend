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
    refreshCompetition: jest.fn()
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
  jest.mocked(runtime.listActiveVoters).mockResolvedValue(['voter']);
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
  expect(service.refreshCompetition).toHaveBeenCalledWith(
    competition.id,
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
