import { handleListCompetitionMyVotesV3 } from './competition-commands.handlers';
import { readCompetitionEntryContexts } from './competition-entry-context.reader';
import { competitionService } from '@/competitions/competition.service';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionInteractionRepository } from '@/competitions/competition-interaction.repository';
import { ListCompetitionMyVotesV3Request } from '@/api/generated/routes/operations';

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: async () => ({
    getActingAsId: () => 'viewer',
    isUserFullyAuthenticated: () => true
  })
}));
jest.mock('@/time', () => ({
  ...jest.requireActual('@/time'),
  Timer: { getFromRequest: () => undefined }
}));
jest.mock('@/competitions/competition.service', () => ({
  competitionService: { getCompetition: jest.fn() }
}));
jest.mock('@/competitions/competition.repository', () => ({
  competitionRepository: { findCompetitionRecordById: jest.fn() }
}));
jest.mock('@/competitions/competition-interaction.repository', () => ({
  competitionInteractionRepository: { myVotes: jest.fn() }
}));
jest.mock('./competition-entry-context.reader', () => ({
  readCompetitionEntryContexts: jest.fn()
}));

const competitionId = '10000000-0000-4000-8000-000000000001';
const request = (query = {}) =>
  ({
    params: { wave_id: 'wave', competition_id: competitionId },
    query
  }) as ListCompetitionMyVotesV3Request;
const vote = (index: number) => ({
  entry_id: `entry-${index}`,
  drop_id: `drop-${index}`,
  value: 10,
  credit_spent: 10,
  entry_status: 'ACTIVE'
});
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(competitionService.getCompetition)
    .mockResolvedValue({ id: competitionId } as never);
  jest
    .mocked(competitionRepository.findCompetitionRecordById)
    .mockResolvedValue({ id: competitionId } as never);
  jest
    .mocked(competitionInteractionRepository.myVotes)
    .mockResolvedValue([vote(0), vote(1)] as never);
  jest
    .mocked(readCompetitionEntryContexts)
    .mockResolvedValue({ data: [{ entry: { id: 'entry-0' } }] } as never);
});
it('keeps the original response unchanged when cards are not requested', async () => {
  expect(await handleListCompetitionMyVotesV3(request())).toEqual({
    data: [vote(0), vote(1)],
    has_more: false,
    next_cursor: null
  });
  expect(readCompetitionEntryContexts).not.toHaveBeenCalled();
});
it('hydrates only the returned page and preserves sparse cards by entry identity', async () => {
  const result = await handleListCompetitionMyVotesV3(
    request({ include: 'cards', limit: 1 })
  );
  expect(result.data).toEqual([vote(0)]);
  expect(result.cards).toEqual([{ entry: { id: 'entry-0' } }]);
  expect(result.has_more).toBe(true);
  expect(result.next_cursor).toEqual(expect.any(String));
  expect(readCompetitionEntryContexts).toHaveBeenCalledWith(
    'wave',
    competitionId,
    ['entry-0'],
    expect.anything(),
    true
  );
});
it('does not hydrate empty pages', async () => {
  jest.mocked(competitionInteractionRepository.myVotes).mockResolvedValue([]);
  expect(
    (await handleListCompetitionMyVotesV3(request({ include: 'cards' }))).cards
  ).toEqual([]);
  expect(readCompetitionEntryContexts).not.toHaveBeenCalled();
});
it('enforces parent access before reading votes or cards', async () => {
  jest
    .mocked(competitionService.getCompetition)
    .mockRejectedValueOnce(new Error('Denied'));
  await expect(
    handleListCompetitionMyVotesV3(request({ include: 'cards' }))
  ).rejects.toThrow('Denied');
  expect(competitionInteractionRepository.myVotes).not.toHaveBeenCalled();
  expect(readCompetitionEntryContexts).not.toHaveBeenCalled();
});
it('rejects unsupported projections', async () => {
  await expect(
    handleListCompetitionMyVotesV3(request({ include: 'full' }))
  ).rejects.toThrow();
});
