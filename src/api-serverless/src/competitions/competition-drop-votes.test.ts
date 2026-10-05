import {
  competitionDropVoteSummary,
  competitionDropVoters,
  competitionDropVoteLogs
} from './competition-drop-votes.service';
import { competitionDropVotesDb } from '@/competitions/competition-drop-votes.db';
import { competitionEntryService } from './competition-entry.service';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import {
  Competition,
  CompetitionEntry
} from '@/competitions/competition.types';
import { DropEntity } from '@/entities/IDrop';

jest.mock('./competition-entry.service', () => ({
  competitionEntryService: { getDropContext: jest.fn() }
}));
jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: {
    getOverviewsByIds: jest.fn(),
    getApiIdentityOverviewsByIds: jest.fn()
  }
}));
jest.mock('@/competitions/competition-drop-votes.db', () => ({
  competitionDropVotesDb: {
    totals: jest.fn(),
    score: jest.fn(),
    voters: jest.fn(),
    logs: jest.fn()
  }
}));
const entry = {
  id: 'entry',
  competition_id: 'competition',
  status: 'ACTIVE',
  rank: null
} as CompetitionEntry;
const competition = { decisions: { time_lock_ms: 0 } } as Competition;
const drop = { id: 'drop', wave_id: 'wave' } as DropEntity;
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(competitionEntryService.getDropContext)
    .mockResolvedValue({ entry, competition } as never);
  jest
    .mocked(competitionDropVotesDb.totals)
    .mockResolvedValue({ total: 39, count: 1, user_vote: 39 });
  jest
    .mocked(competitionDropVotesDb.score)
    .mockResolvedValue({ rating: 0, rank: 1, over_threshold_since: 1234 });
  jest
    .mocked(competitionDropVotesDb.voters)
    .mockResolvedValue([{ voter_id: 'viewer', vote: 39 }]);
  jest
    .mocked(identityFetcher.getOverviewsByIds)
    .mockResolvedValue({ viewer: { id: 'viewer' } } as never);
  jest
    .mocked(identityFetcher.getApiIdentityOverviewsByIds)
    .mockResolvedValue({ viewer: { id: 'viewer' } } as never);
});
it('shows accepted votes immediately without waiting for a leaderboard refresh', async () => {
  expect(
    await competitionDropVoteSummary(competition, entry, {})
  ).toMatchObject({
    rating: 39,
    realtime_rating: 39,
    rating_prediction: 39,
    user_vote: 39,
    raters_count: 1,
    rank: 1,
    over_threshold_since_ms: 1234,
    top_raters: [{ rating: 39, profile: { id: 'viewer' } }]
  });
});
it('keeps weighted current totals separate from the full vote total', async () => {
  const weighted = { decisions: { time_lock_ms: 1000 } } as Competition;
  expect(await competitionDropVoteSummary(weighted, entry, {})).toMatchObject({
    rating: 0,
    rating_prediction: 39
  });
});
it('uses the native voters and existing dropdown response shape', async () => {
  expect(
    await competitionDropVoters(
      drop,
      { page: 1, page_size: 20, sort_direction: 'DESC' },
      {}
    )
  ).toMatchObject({
    count: 1,
    next: false,
    data: [{ voter: { id: 'viewer' }, vote: 39 }]
  });
  expect(competitionEntryService.getDropContext).toHaveBeenCalledWith(
    'wave',
    'drop',
    {}
  );
});
it('shows actual vote changes in the existing log format', async () => {
  jest.mocked(competitionDropVotesDb.logs).mockResolvedValue([
    {
      id: '1',
      voter_profile_id: 'viewer',
      old_vote: -5,
      new_vote: 39,
      created_at: 123
    }
  ]);
  expect(
    await competitionDropVoteLogs(
      drop,
      { offset: 0, limit: 20, sort_direction: 'DESC' },
      {}
    )
  ).toEqual([
    {
      id: '1',
      old_vote: -5,
      new_vote: 39,
      created_at: 123,
      voter: { id: 'viewer' }
    }
  ]);
});
