import { apiDropMapper } from '@/api/drops/api-drop.mapper';
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
  dropsDb: { getDropsByIds: jest.fn(), findMetadataByDropIds: jest.fn() }
}));
jest.mock('@/api/drops/api-drop.mapper', () => ({
  apiDropMapper: { mapDrops: jest.fn() }
}));
jest.mock('./competition-api.mapper', () => ({
  toApiCompetition: (value: unknown) => value,
  toApiEntryPage: async (value: unknown) => value
}));
jest.mock('./competitions-v3.handlers', () => ({
  getContext: async () => ({
    authenticationContext: { getActingAsId: () => 'viewer' }
  }),
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
  jest
    .mocked(apiDropMapper.mapDrops)
    .mockResolvedValue({ drop: { id: 'drop' } } as never);
  jest
    .mocked(dropsDb.findMetadataByDropIds)
    .mockResolvedValue([
      { drop_id: 'drop', data_key: 'Artist', data_value: 'Artist name' }
    ] as never);
  jest.mocked(competitionService.getCompetition).mockResolvedValue({
    id: competitionId,
    wave_id: 'wave',
    decisions: { time_lock_ms: null },
    permissions: { vote: true }
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
it.each(['not-a-uuid', `${entryId},${entryId}`, '', `${entryId},`])(
  'rejects invalid or duplicate entry identifiers %s',
  async (ids) => {
    await expect(
      handleGetCompetitionEntryContextsV3(request(ids))
    ).rejects.toThrow();
    expect(competitionService.getCompetition).not.toHaveBeenCalled();
  }
);

it('returns renderable content and native votes together without legacy vote enrichment', async () => {
  const req = request();
  req.query.include = 'cards';
  const result = await handleGetCompetitionEntryContextsV3(req);
  expect(apiDropMapper.mapDrops).toHaveBeenCalledWith(
    [{ id: 'drop', wave_id: 'wave' }],
    expect.anything(),
    { includeSubmissionVoting: false }
  );
  expect(result.data[0].drop).toMatchObject({
    id: 'drop',
    submission_context: {
      status: 'ACTIVE',
      voting: {
        current_calculated_vote: 7,
        context_profile_context: { current: 7 }
      }
    }
  });
  expect(result.data[0].metadata).toEqual([
    { data_key: 'Artist', data_value: 'Artist name' }
  ]);
});
it.each(['ACTIVE', 'WINNER'])(
  'preserves each %s card’s additional-action promise without legacy vote enrichment',
  async (status) => {
    const entries = [2, 3, 4].map((suffix) => ({
      id: `10000000-0000-4000-8000-00000000000${suffix}`,
      drop_id: `drop-${suffix}`,
      status,
      rank: null
    }));
    const drops = [null, false, true].map((promised, index) => ({
      id: entries[index].drop_id,
      wave_id: 'wave',
      is_additional_action_promised: promised
    }));
    jest
      .mocked(competitionRepository.findNativeEntriesByIds)
      .mockResolvedValue(entries as never);
    jest
      .mocked(dropsDb.getDropsByIds)
      .mockResolvedValue([...drops].reverse() as never);
    jest
      .mocked(apiDropMapper.mapDrops)
      .mockResolvedValue(
        Object.fromEntries(drops.map(({ id }) => [id, { id }])) as never
      );
    const req = request(entries.map(({ id }) => id).join(','));
    req.query.include = 'cards';

    const result = await handleGetCompetitionEntryContextsV3(req);

    expect(result.data).toHaveLength(3);
    expect(result.data[0].drop?.submission_context).toBeDefined();
    expect(result.data[0].drop?.submission_context).not.toHaveProperty(
      'is_additional_action_promised'
    );
    for (const index of [1, 2]) {
      expect(result.data[index].drop).toMatchObject({
        id: drops[index].id,
        submission_context: {
          status,
          is_additional_action_promised:
            drops[index].is_additional_action_promised
        }
      });
    }
    expect(apiDropMapper.mapDrops).toHaveBeenCalledWith(
      [...drops].reverse(),
      expect.anything(),
      { includeSubmissionVoting: false }
    );
    expect(dropsDb.getDropsByIds).toHaveBeenCalledTimes(1);
  }
);

it('refreshes summaries without loading card content', async () => {
  const result = await handleGetCompetitionEntryContextsV3(request());
  expect(result.data[0].drop).toBeUndefined();
  expect(apiDropMapper.mapDrops).not.toHaveBeenCalled();
  expect(dropsDb.findMetadataByDropIds).not.toHaveBeenCalled();
});
it('does not enrich cards hidden from the viewer', async () => {
  jest.mocked(contentModerationDb.getPresentations).mockResolvedValue({
    drop: {
      moderation: { can_view: false },
      viewer: { author_blocked: false, drop_hidden: false }
    }
  } as never);
  const req = request();
  req.query.include = 'cards';
  expect((await handleGetCompetitionEntryContextsV3(req)).data).toEqual([]);
  expect(apiDropMapper.mapDrops).not.toHaveBeenCalled();
});

it('does not expose metadata when the content mapper observes a newer moderation decision', async () => {
  jest.mocked(apiDropMapper.mapDrops).mockResolvedValue({
    drop: { id: 'drop', moderation: { can_view: false } }
  } as never);
  const req = request();
  req.query.include = 'cards';
  const result = await handleGetCompetitionEntryContextsV3(req);
  expect(result.data[0].drop).toBeUndefined();
  expect(result.data[0].metadata).toBeUndefined();
  expect(result.data[0].vote_summary).toMatchObject({
    rating: 7,
    user_vote: 7
  });
  expect(result.data[0].awards).toEqual([]);
});
