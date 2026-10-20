import {
  competitionService,
  PublicCompetition
} from '@/competitions/competition.service';
import {
  competitionRepository,
  CompetitionRecord
} from '@/competitions/competition.repository';
import { competitionVoteActivityRepository } from '@/competitions/competition-vote-activity.repository';
import { CompetitionStorageMode } from '@/entities/ICompetition';
import { dropsService } from '@/api/drops/drops.api.service';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import { PageSortDirection } from '@/api/page-request';
import { NotFoundException } from '@/exceptions';
import { listCompetitionVoteActivity } from './competition-vote-activity.service';

jest.mock('@/competitions/competition.service', () => ({
  competitionService: { getCompetition: jest.fn() }
}));
jest.mock('@/competitions/competition.repository', () => ({
  competitionRepository: { findCompetitionRecordById: jest.fn() }
}));
jest.mock('@/competitions/competition-vote-activity.repository', () => ({
  competitionVoteActivityRepository: {
    list: jest.fn(),
    listTransferred: jest.fn(),
    hasExactLineage: jest.fn()
  }
}));
jest.mock('@/api/drops/drops.api.service', () => ({
  dropsService: { findWaveLogs: jest.fn() }
}));
jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: { getOverviewsByIds: jest.fn() }
}));

const profile = { id: 'voter' } as ApiProfileMin;
const submitter = { id: 'submitter' } as ApiProfileMin;
const proxy = { id: 'proxy' } as ApiProfileMin;
const read = () =>
  listCompetitionVoteActivity('wave', 'competition', 20, 50, {});

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(competitionService.getCompetition)
    .mockResolvedValue({ legacy_transferred_at: 10000 } as PublicCompetition);
  jest
    .mocked(competitionRepository.findCompetitionRecordById)
    .mockResolvedValue({
      id: 'competition',
      wave_id: 'wave',
      legacy_wave_id: 'wave',
      storage_mode: CompetitionStorageMode.NATIVE
    } as CompetitionRecord);
  jest
    .mocked(identityFetcher.getOverviewsByIds)
    .mockResolvedValue({ voter: profile, submitter, proxy });
  jest.mocked(competitionVoteActivityRepository.list).mockResolvedValue([]);
  jest
    .mocked(competitionVoteActivityRepository.hasExactLineage)
    .mockResolvedValue(true);
  jest
    .mocked(competitionVoteActivityRepository.listTransferred)
    .mockResolvedValue([]);
});

it('restores transferred primary history with original IDs, adjustment reasons and proxy attribution', async () => {
  const contents = {
    reason: 'CREDIT_OVERSPENT',
    oldVote: '85192',
    newVote: 555
  };
  jest
    .mocked(competitionVoteActivityRepository.listTransferred)
    .mockResolvedValue([
      {
        sequence: 0,
        legacy_id: 'original-log',
        legacy_contents: JSON.stringify(contents),
        proxy_id: 'proxy',
        drop_id: 'drop',
        voter_profile_id: 'voter',
        submitter_id: 'submitter',
        previous_value: 0,
        value: 0,
        occurred_at: 9000
      }
    ]);
  expect(await read()).toEqual([
    {
      id: 'original-log',
      action: 'DROP_VOTE_EDIT',
      wave_id: 'wave',
      drop_id: 'drop',
      invoker: profile,
      invoker_proxy: proxy,
      drop_author: submitter,
      created_at: new Date(9000),
      contents
    }
  ]);
  expect(
    competitionVoteActivityRepository.listTransferred
  ).toHaveBeenCalledWith('competition', 'wave', null, 20, 50, {});
  expect(dropsService.findWaveLogs).not.toHaveBeenCalled();
});

it('preserves the original null shared timestamp without inventing an epoch date', async () => {
  jest
    .mocked(competitionVoteActivityRepository.listTransferred)
    .mockResolvedValue([
      {
        sequence: 0,
        legacy_id: 'unknown-time',
        legacy_created_at: null,
        drop_id: 'drop',
        voter_profile_id: 'voter',
        submitter_id: null,
        previous_value: 0,
        value: 0,
        occurred_at: null
      }
    ]);
  expect(await read()).toMatchObject([
    { id: 'unknown-time', created_at: null }
  ]);
});

it('does not expose primary-wave logs through a separate native competition', async () => {
  jest
    .mocked(competitionRepository.findCompetitionRecordById)
    .mockResolvedValue({
      id: 'competition',
      wave_id: 'wave',
      legacy_wave_id: null,
      storage_mode: CompetitionStorageMode.NATIVE
    } as CompetitionRecord);
  jest.mocked(competitionVoteActivityRepository.list).mockResolvedValue([
    {
      sequence: 7,
      drop_id: 'drop',
      voter_profile_id: 'voter',
      submitter_id: 'submitter',
      previous_value: 3,
      value: 4,
      occurred_at: 11000
    }
  ]);
  expect(await read()).toMatchObject([
    { id: 'competition:7', contents: { oldVote: 3, newVote: 4 } }
  ]);
  expect(
    competitionVoteActivityRepository.listTransferred
  ).not.toHaveBeenCalled();
  expect(
    competitionVoteActivityRepository.hasExactLineage
  ).not.toHaveBeenCalled();
});

it('keeps the established timestamp cutoff for an older native primary', async () => {
  jest
    .mocked(competitionVoteActivityRepository.hasExactLineage)
    .mockResolvedValue(false);
  expect(await read()).toEqual([]);
  expect(
    competitionVoteActivityRepository.listTransferred
  ).toHaveBeenCalledWith('competition', 'wave', 10000, 20, 50, {});
});

it('keeps the established wave-log reader for an unqualified legacy adapter', async () => {
  jest
    .mocked(competitionVoteActivityRepository.hasExactLineage)
    .mockResolvedValue(false);
  jest
    .mocked(competitionRepository.findCompetitionRecordById)
    .mockResolvedValue({
      wave_id: 'wave',
      legacy_wave_id: 'wave',
      storage_mode: CompetitionStorageMode.LEGACY_ADAPTER
    } as CompetitionRecord);
  jest.mocked(dropsService.findWaveLogs).mockResolvedValue([]);
  expect(await read()).toEqual([]);
  expect(dropsService.findWaveLogs).toHaveBeenCalledWith(
    {
      wave_id: 'wave',
      offset: 20,
      limit: 50,
      drop_id: null,
      log_types: ['DROP_VOTE_EDIT'],
      sort_direction: PageSortDirection.DESC
    },
    {}
  );
  expect(
    competitionVoteActivityRepository.listTransferred
  ).not.toHaveBeenCalled();
  expect(competitionVoteActivityRepository.list).not.toHaveBeenCalled();
});

it('uses the same combined history after rollback to the legacy adapter', async () => {
  jest
    .mocked(competitionRepository.findCompetitionRecordById)
    .mockResolvedValue({
      id: 'competition',
      wave_id: 'wave',
      legacy_wave_id: 'wave',
      storage_mode: CompetitionStorageMode.LEGACY_ADAPTER
    } as CompetitionRecord);
  jest
    .mocked(competitionService.getCompetition)
    .mockResolvedValue({} as PublicCompetition);
  expect(await read()).toEqual([]);
  expect(
    competitionVoteActivityRepository.listTransferred
  ).toHaveBeenCalledWith('competition', 'wave', null, 20, 50, {});
  expect(dropsService.findWaveLogs).not.toHaveBeenCalled();
});

it('masks unreadable competitions before querying any history', async () => {
  jest
    .mocked(competitionService.getCompetition)
    .mockRejectedValue(new NotFoundException('Competition not found'));
  await expect(read()).rejects.toThrow('Competition not found');
  expect(
    competitionRepository.findCompetitionRecordById
  ).not.toHaveBeenCalled();
  expect(
    competitionVoteActivityRepository.listTransferred
  ).not.toHaveBeenCalled();
});

it('rejects a child from another wave without querying its history', async () => {
  jest
    .mocked(competitionRepository.findCompetitionRecordById)
    .mockResolvedValue({ wave_id: 'other-wave' } as CompetitionRecord);
  await expect(read()).rejects.toThrow('Competition not found');
  expect(
    competitionVoteActivityRepository.listTransferred
  ).not.toHaveBeenCalled();
});
