import {
  handleGetWaveCompetitionV3,
  handleListWaveCompetitionsV3
} from '@/api/competitions/competitions-v3.handlers';
import { getAuthenticationContext } from '@/api/auth/auth';
import { competitionService } from '@/competitions/competition.service';
import { BadRequestException } from '@/exceptions';

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn()
}));
jest.mock('@/competitions/competition.service', () => ({
  competitionService: {
    getCompetition: jest.fn(),
    listCompetitions: jest.fn()
  }
}));
jest.mock('@/time', () => ({
  ...jest.requireActual('@/time'),
  Timer: { getFromRequest: jest.fn().mockReturnValue(undefined) }
}));

const competitionId = '10000000-0000-4000-8000-000000000001';
const publicCompetition = {
  id: competitionId,
  wave_id: 'wave-a',
  type: 'RANK',
  title: 'Competition',
  description: null,
  lifecycle: 'PUBLISHED',
  computed_phase: 'PARTICIPATION_OPEN',
  config_version: 1,
  participation: {},
  voting: {},
  decisions: {},
  winners: {},
  outcome_config: [],
  capabilities: [],
  permissions: {
    view: true,
    submit: false,
    vote: false,
    administer: false
  },
  created_at: 1,
  updated_at: 1,
  published_at: 1,
  ended_at: null,
  cancelled_at: null,
  archived_at: null
};

describe('competition v3 handlers', () => {
  const authenticationContext = { id: 'auth-context' };

  beforeEach(() => {
    jest.clearAllMocks();
    (getAuthenticationContext as jest.Mock).mockResolvedValue(
      authenticationContext
    );
    (competitionService.getCompetition as jest.Mock).mockResolvedValue(
      publicCompetition
    );
    (competitionService.listCompetitions as jest.Mock).mockResolvedValue({
      data: [publicCompetition],
      next_cursor: null,
      has_more: false
    });
  });

  it('passes optional authentication and validated stable paging defaults', async () => {
    await expect(
      handleListWaveCompetitionsV3({
        params: { wave_id: 'wave-a' },
        query: {}
      } as never)
    ).resolves.toMatchObject({
      data: [{ id: competitionId }],
      next_cursor: null,
      has_more: false
    });
    expect(competitionService.listCompetitions).toHaveBeenCalledWith(
      'wave-a',
      expect.objectContaining({
        sort: 'created_at',
        direction: 'ASC',
        limit: 50
      }),
      { authenticationContext, timer: undefined }
    );
  });

  it('rejects unknown query parameters before reading data', async () => {
    await expect(
      handleGetWaveCompetitionV3({
        params: { wave_id: 'wave-a', competition_id: competitionId },
        query: { current: 'true' }
      } as never)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(competitionService.getCompetition).not.toHaveBeenCalled();
  });
});
