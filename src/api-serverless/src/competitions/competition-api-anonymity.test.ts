import { AuthenticationContext } from '@/auth-context';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { CompetitionEntry } from '@/competitions/competition.types';
import { competitionAnonymityService } from '@/competitions/competition-anonymity';
import { memeCardDropMappingsDb } from '@/minting-claims/meme-card-drop-mappings.db';
import { toApiEntry, toApiEntryPage } from './competition-api.mapper';

const author = {
  id: 'artist',
  handle: 'PrivateArtist',
  primary_address: 'private-wallet',
  pfp: 'private-avatar',
  level: 42
} as ApiProfileMin;

function entry(id: string, winner = false): CompetitionEntry {
  return {
    id,
    wave_id: 'wave',
    competition_id: 'competition',
    drop_id: `drop-${id}`,
    submitter_id: author.id,
    status: winner
      ? CompetitionEntryStatus.WINNER
      : CompetitionEntryStatus.ACTIVE,
    config_version: 1,
    submitted_at: 10,
    rank: winner ? 1 : null,
    won_at: winner ? 20 : null,
    decision_id: winner ? 'decision' : null
  };
}

beforeEach(() => {
  jest
    .spyOn(identityFetcher, 'getOverviewsByIds')
    .mockResolvedValue({ artist: author });
  jest
    .spyOn(memeCardDropMappingsDb, 'findMemeCardIdsByEntryIds')
    .mockResolvedValue({});
  jest
    .spyOn(competitionAnonymityService, 'hiddenDropIds')
    .mockResolvedValue(new Set(['drop-active']));
});

afterEach(() => jest.restoreAllMocks());

it('conceals every platform profile field on a single unrevealed entry', async () => {
  const result = await toApiEntry(entry('active'), {});
  expect(result.submitter).toMatchObject({
    handle: 'Anonymous',
    is_anonymous: true,
    primary_address: '',
    pfp: null,
    level: 0
  });
  expect(result.submitter.id).not.toBe(author.id);
  expect(JSON.stringify(result)).not.toContain('PrivateArtist');
  expect(JSON.stringify(result)).not.toContain('private-wallet');
  expect(result).not.toHaveProperty('submitter_id');
});

it('reveals a winning entry without linking the same author’s other submissions', async () => {
  const result = await toApiEntryPage(
    {
      data: [entry('active'), entry('winner', true)],
      has_more: false,
      next_cursor: null
    },
    {}
  );
  expect(result.data[0].submitter).toMatchObject({ is_anonymous: true });
  expect(result.data[1].submitter).toBe(author);
  expect(result.data[0].submitter.id).not.toBe(result.data[1].submitter.id);
  expect(author.handle).toBe('PrivateArtist');
});

it('uses the authenticated viewer policy so owners can manage their own entries', async () => {
  const ctx = {
    authenticationContext: AuthenticationContext.fromProfileId(author.id)
  };
  jest
    .mocked(competitionAnonymityService.hiddenDropIds)
    .mockResolvedValue(new Set());
  const result = await toApiEntry(entry('active'), ctx);
  expect(result.submitter).toBe(author);
  expect(competitionAnonymityService.hiddenDropIds).toHaveBeenCalledWith(
    ['drop-active'],
    ctx
  );
});
