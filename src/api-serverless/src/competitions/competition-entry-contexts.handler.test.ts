import { handleGetCompetitionEntryContextsV3 } from './competition-entry-contexts.handler';
import { competitionService } from '@/competitions/competition.service';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionEntrySummaryDb } from '@/competitions/competition-entry-summary.db';
import { contentModerationDb } from '@/content-moderation/content-moderation.db';
import { dropsDb } from '@/drops/drops.db';
import { GetCompetitionEntryContextsV3Request } from '@/api/generated/routes/operations';

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: async () => ({ getActingAsId: () => 'viewer' })
}));
jest.mock('@/time', () => ({ Timer: { getFromRequest: () => undefined } }));
jest.mock('@/api/identities/identity.fetcher', () => ({
  identityFetcher: { getOverviewsByIds: async () => ({}) }
}));
jest.mock('@/competitions/competition.service', () => ({
  competitionService: { getCompetition: jest.fn() }
}));
jest.mock('@/competitions/competition.repository', () => ({
  competitionRepository: { findNativeEntriesByIds: jest.fn() }
}));
jest.mock('@/competitions/competition-entry-summary.db', () => ({
  competitionEntrySummaryDb: { read: jest.fn() }
}));
jest.mock('@/competitions/competition-interaction.repository', () => ({
  competitionInteractionRepository: { awards: async () => [] }
}));
jest.mock('@/content-moderation/content-moderation.db', () => ({
  contentModerationDb: { getPresentations: jest.fn() }
}));
jest.mock('@/drops/drops.db', () => ({
  dropsDb: { getDropsByIds: jest.fn() }
}));
jest.mock('./competitions-v3.handlers', () => ({
  toApiCompetition: (value: unknown) => value,
  toApiEntryPage: async (value: unknown) => value
}));
const competitionId = '10000000-0000-4000-8000-000000000001';
const entryId = '10000000-0000-4000-8000-000000000002';
const request = (entryIds = entryId) =>
  ({
    params: { wave_id: 'wave', competition_id: competitionId },
    query: { entry_ids: entryIds }
  }) as GetCompetitionEntryContextsV3Request;
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(competitionService.getCompetition).mockResolvedValue({
    id: competitionId,
    wave_id: 'wave',
    decisions: { time_lock_ms: null }
  } as never);
  jest
    .mocked(competitionRepository.findNativeEntriesByIds)
    .mockResolvedValue([
      { id: entryId, drop_id: 'drop', status: 'ACTIVE', rank: null }
    ] as never);
  jest
    .mocked(dropsDb.getDropsByIds)
    .mockResolvedValue([{ id: 'drop', wave_id: 'wave' }] as never);
  jest.mocked(contentModerationDb.getPresentations).mockResolvedValue({});
  jest.mocked(competitionEntrySummaryDb.read).mockResolvedValue({
    totals: new Map([[entryId, { total: 7, count: 1, user_vote: 7 }]]),
    scores: new Map(),
    voters: []
  } as never);
});
it('checks competition access once and batches only visible entries', async () => {
  const result = await handleGetCompetitionEntryContextsV3(request());
  expect(competitionService.getCompetition).toHaveBeenCalledTimes(1);
  expect(result.data[0].vote_summary).toMatchObject({
    rating: 7,
    user_vote: 7,
    raters_count: 1
  });
  expect(competitionEntrySummaryDb.read).toHaveBeenCalledWith(
    competitionId,
    [entryId],
    'viewer',
    expect.anything()
  );
});
it.each(['moderated', 'blocked', 'hidden'])(
  'omits %s content before reading vote data',
  async (kind) => {
    jest.mocked(contentModerationDb.getPresentations).mockResolvedValue({
      drop: {
        moderation: { can_view: kind !== 'moderated' },
        viewer: {
          author_blocked: kind === 'blocked',
          drop_hidden: kind === 'hidden'
        }
      }
    } as never);
    expect((await handleGetCompetitionEntryContextsV3(request())).data).toEqual(
      []
    );
    expect(competitionEntrySummaryDb.read).not.toHaveBeenCalled();
  }
);
it('does not read membership after a parent access denial', async () => {
  jest
    .mocked(competitionService.getCompetition)
    .mockRejectedValueOnce(new Error('Not found'));
  await expect(handleGetCompetitionEntryContextsV3(request())).rejects.toThrow(
    'Not found'
  );
  expect(competitionRepository.findNativeEntriesByIds).not.toHaveBeenCalled();
});
it.each(['not-a-uuid', `${entryId},${entryId}`, ''])(
  'rejects invalid or duplicate entry identifiers %s',
  async (ids) => {
    await expect(
      handleGetCompetitionEntryContextsV3(request(ids))
    ).rejects.toThrow();
    expect(competitionService.getCompetition).not.toHaveBeenCalled();
  }
);
