import {
  handleGetWaveCompetitionV3,
  handleGetDefaultWaveCompetitionV3,
  handleListCompetitionLeaderboardV3,
  handleListCompetitionVotersV3,
  handleListWaveCompetitionsV3
} from '@/api/competitions/competitions-v3.handlers';
import { getAuthenticationContext } from '@/api/auth/auth';
import {
  competitionService,
  PublicCompetition
} from '@/competitions/competition.service';
import { CompetitionComputedPhase } from '@/competitions/competition.types';
import {
  CompetitionCapability,
  CompetitionLifecycle,
  CompetitionType
} from '@/entities/ICompetition';
import { ApiCompetitionType } from '@/api/generated/models/ApiCompetitionType';
import { ApiCompetitionLifecycle } from '@/api/generated/models/ApiCompetitionLifecycle';
import { ApiCompetitionComputedPhase } from '@/api/generated/models/ApiCompetitionComputedPhase';
import { ApiCompetitionCapability } from '@/api/generated/models/ApiCompetitionCapability';
import { ApiCompetitionParticipationConfigRequiredMediaEnum } from '@/api/generated/models/ApiCompetitionParticipationConfig';
import { BadRequestException } from '@/exceptions';

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn()
}));
jest.mock('@/competitions/competition.service', () => ({
  competitionService: {
    getCompetition: jest.fn(),
    getDefaultCompetition: jest.fn(),
    listCompetitions: jest.fn(),
    listVoters: jest.fn(),
    listLeaderboard: jest.fn()
  }
}));
jest.mock('@/time', () => ({
  ...jest.requireActual('@/time'),
  Timer: { getFromRequest: jest.fn().mockReturnValue(undefined) }
}));

const competitionId = '10000000-0000-4000-8000-000000000001';
const publicCompetition: PublicCompetition = {
  id: competitionId,
  wave_id: 'wave-a',
  type: CompetitionType.RANK,
  title: 'Competition',
  description: null,
  lifecycle: CompetitionLifecycle.PUBLISHED,
  computed_phase: CompetitionComputedPhase.PARTICIPATION_OPEN,
  config_version: 1,
  participation: {
    group_id: null,
    signature_required: false,
    max_entries_per_participant: 1,
    required_metadata: [{ name: 'Artist', type: 'STRING' }],
    required_media: ['IMAGE'],
    submission_type: null,
    identity_submission_strategy: null,
    identity_submission_duplicates: null,
    starts_at: 1,
    ends_at: 1000,
    terms: 'Submit original artwork.'
  },
  voting: {
    group_id: null,
    credit_type: 'CARD_SET_TDH',
    credit_scope: 'WAVE',
    credit_category: null,
    credit_creditor: null,
    credit_nfts: [{ contract: `0x${'a'.repeat(40)}`, token_id: 1 }],
    signature_required: false,
    starts_at: 1000,
    ends_at: 2000,
    max_votes_per_identity_to_entry: null,
    forbid_negative_votes: false
  },
  decisions: {
    strategy: {
      first_decision_time: 2000,
      subsequent_decisions: [],
      is_rolling: false
    },
    next_decision_time: 2000,
    winning_min_threshold: null,
    winning_max_threshold: null,
    winning_threshold_min_duration_ms: 0,
    max_winners: null,
    time_lock_ms: null
  },
  winners: {
    max_winners: null,
    winning_min_threshold: null,
    winning_max_threshold: null,
    winning_threshold_min_duration_ms: 0
  },
  outcome_config: [{ type: 'MANUAL', description: 'Curator selection' }],
  capabilities: [CompetitionCapability.CURATION],
  presentation: [
    {
      data_key: 'wave_display.submission.button_label',
      data_value: 'Submit art'
    }
  ],
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

  it('returns the authoritative default with optional viewer context and rejects query overrides', async () => {
    const selection = {
      competition_id: competitionId,
      evaluated_at: 100,
      next_refresh_at: 200
    };
    (competitionService.getDefaultCompetition as jest.Mock).mockResolvedValue(
      selection
    );
    await expect(
      handleGetDefaultWaveCompetitionV3({
        params: { wave_id: 'wave-a' },
        query: {}
      } as never)
    ).resolves.toEqual(selection);
    expect(competitionService.getDefaultCompetition).toHaveBeenCalledWith(
      'wave-a',
      { timer: undefined, authenticationContext }
    );
    await expect(
      handleGetDefaultWaveCompetitionV3({
        params: { wave_id: 'wave-a' },
        query: { competition_id: competitionId }
      } as never)
    ).rejects.toBeInstanceOf(BadRequestException);
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

  it('maps configured collections and enums into the public detail response', async () => {
    const response = await handleGetWaveCompetitionV3({
      params: { wave_id: 'wave-a', competition_id: competitionId },
      query: {}
    } as never);
    expect(response).toMatchObject({
      type: ApiCompetitionType.Rank,
      lifecycle: ApiCompetitionLifecycle.Published,
      computed_phase: ApiCompetitionComputedPhase.ParticipationOpen,
      participation: {
        required_metadata: [{ name: 'Artist', type: 'STRING' }],
        required_media: [
          ApiCompetitionParticipationConfigRequiredMediaEnum.Image
        ]
      },
      voting: {
        credit_nfts: [{ contract: `0x${'a'.repeat(40)}`, token_id: 1 }]
      },
      capabilities: [ApiCompetitionCapability.Curation],
      outcome_config: [{ type: 'MANUAL', description: 'Curator selection' }],
      presentation: [
        {
          data_key: 'wave_display.submission.button_label',
          data_value: 'Submit art'
        }
      ]
    });
  });

  it('rejects malformed voter entry filters before reading data', async () => {
    await expect(
      handleListCompetitionVotersV3({
        params: { wave_id: 'wave-a', competition_id: competitionId },
        query: { entry_id: 'not-a-uuid' }
      } as never)
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(competitionService.listVoters).not.toHaveBeenCalled();
  });
});

it.each(['rating', 'real_time_rating', 'submitted_at', 'trend'])(
  'forwards leaderboard sort %s in the competition scope',
  async (sort) => {
    await handleListCompetitionLeaderboardV3({
      params: { wave_id: 'wave-a', competition_id: competitionId },
      query: { sort }
    } as never);
    expect(competitionService.listLeaderboard).toHaveBeenLastCalledWith(
      'wave-a',
      competitionId,
      expect.objectContaining({ sort, direction: 'DESC' }),
      expect.anything()
    );
  }
);
