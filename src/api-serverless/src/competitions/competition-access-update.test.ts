import { competitionLifecycleService } from './competition-lifecycle.service';
import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { ApiCompetitionRulesInputTypeEnum } from '@/api/generated/models/ApiCompetitionRulesInput';
import { ApiWaveCreditType } from '@/api/generated/models/ApiWaveCreditType';
import { ApiWaveCreditScope } from '@/api/generated/models/ApiWaveCreditScope';
import { competitionCommandRepository } from '@/competitions/competition-command.repository';
import { nativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';
import { waveApiService } from '@/api/waves/wave.api.service';
import {
  administerCompetitionWave,
  lockNativeCompetition
} from './competition-command-access';

jest.mock('@/api/identities/identity.fetcher', () => ({ identityFetcher: {} }));
jest.mock('@/api/waves/wave.api.service', () => ({
  waveApiService: { validateNativeCompetitionConfiguration: jest.fn() }
}));
jest.mock('@/competitions/competition.service', () => ({
  competitionService: { getCompetition: jest.fn() }
}));
jest.mock('@/competitions/competition.repository', () => ({
  competitionRepository: { parseCompetitionRecord: (record: unknown) => record }
}));
jest.mock('@/competitions/native-competition-runtime.repository', () => ({
  nativeCompetitionRuntimeRepository: { enqueueEvent: jest.fn() }
}));
jest.mock('./competition-command-access', () => ({
  requireNativeWrites: jest.fn(),
  administerCompetitionWave: jest.fn(),
  competitionActor: () => 'admin',
  lockNativeCompetition: jest.fn()
}));
jest.mock('@/competitions/competition-command.repository', () => ({
  competitionConflict: (message: string) => {
    throw new Error(message);
  },
  competitionCommandRepository: {
    command: (
      _actor: unknown,
      _key: unknown,
      _input: unknown,
      action: (ctx: object) => unknown
    ) => action({}),
    getConfiguration: jest.fn(),
    hasActivity: jest.fn(),
    saveCompetition: jest.fn(),
    replaceOutcomeDefinitions: jest.fn()
  }
}));

const original: ApiCompetitionDraftInput = {
  title: 'Competition',
  description: null,
  presentation: [],
  outcomes: [],
  participation: {
    scope: { group_id: 'old-participants' },
    period: { min: 1, max: 2 },
    signature_required: false,
    no_of_applications_allowed_per_participant: null,
    required_media: [],
    required_metadata: [],
    terms: null
  },
  voting: {
    scope: { group_id: 'old-voters' },
    period: { min: 1, max: 2 },
    credit_type: ApiWaveCreditType.Tdh,
    credit_scope: ApiWaveCreditScope.Wave,
    credit_category: null,
    creditor_id: null,
    signature_required: false,
    forbid_negative_votes: false
  },
  rules: {
    type: ApiCompetitionRulesInputTypeEnum.Rank,
    winning_threshold: null,
    winning_threshold_min_duration_ms: null,
    max_winners: null,
    max_votes_per_identity_to_drop: null,
    time_lock_ms: null,
    decisions_strategy: {
      first_decision_time: 2,
      subsequent_decisions: [],
      is_rolling: false
    }
  }
};
const progress = { next_decision_time: null, completed: true };
const record = {
  id: 'competition',
  wave_id: 'wave',
  lifecycle: 'PUBLISHED',
  config_version: 4,
  decision_config: progress
};
const update = (config: ApiCompetitionDraftInput) =>
  competitionLifecycleService.update(
    'wave',
    'competition',
    {
      idempotency_key: 'request',
      config_version: 4,
      config
    },
    {}
  );

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(administerCompetitionWave)
    .mockResolvedValue({ wave: { id: 'wave' } } as never);
  jest.mocked(lockNativeCompetition).mockResolvedValue({ record } as never);
  jest
    .mocked(competitionCommandRepository.getConfiguration)
    .mockResolvedValue(original);
  jest.mocked(competitionCommandRepository.hasActivity).mockResolvedValue(true);
  jest
    .mocked(waveApiService.validateNativeCompetitionConfiguration)
    .mockResolvedValue(undefined);
});

it.each([
  ApiCompetitionRulesInputTypeEnum.Rank,
  ApiCompetitionRulesInputTypeEnum.Approve
])(
  'allows %s access edits after activity without resetting decision progress or outcomes',
  async (type) => {
    const config = { ...original, rules: { ...original.rules, type } };
    jest
      .mocked(competitionCommandRepository.getConfiguration)
      .mockResolvedValue(config);
    await update({
      ...config,
      participation: {
        ...config.participation,
        scope: { group_id: 'new-participants' }
      },
      voting: { ...config.voting, scope: { group_id: null } }
    });
    expect(competitionCommandRepository.saveCompetition).toHaveBeenCalledWith(
      expect.objectContaining({
        config_version: 5,
        participation_config: expect.objectContaining({
          group_id: 'new-participants'
        }),
        voting_config: expect.objectContaining({ group_id: null }),
        decision_config: progress
      }),
      'admin',
      expect.anything(),
      expect.anything()
    );
    expect(
      competitionCommandRepository.replaceOutcomeDefinitions
    ).not.toHaveBeenCalled();
    expect(
      waveApiService.validateNativeCompetitionConfiguration
    ).toHaveBeenCalled();
    expect(
      nativeCompetitionRuntimeRepository.enqueueEvent
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'COMPETITION_UPDATED'
      }),
      expect.anything()
    );
  }
);

it('still rejects other rule changes bundled with an access edit after activity', async () => {
  await expect(
    update({
      ...original,
      voting: {
        ...original.voting,
        scope: { group_id: null },
        signature_required: true
      }
    })
  ).rejects.toThrow('immutable after');
  expect(competitionCommandRepository.saveCompetition).not.toHaveBeenCalled();
});

it('keeps access validation enforced', async () => {
  jest
    .mocked(waveApiService.validateNativeCompetitionConfiguration)
    .mockRejectedValue(new Error('Invalid access group'));
  await expect(
    update({
      ...original,
      participation: {
        ...original.participation,
        scope: { group_id: 'invalid' }
      }
    })
  ).rejects.toThrow('Invalid access group');
  expect(competitionCommandRepository.saveCompetition).not.toHaveBeenCalled();
});

it('rejects non-administrators', async () => {
  jest
    .mocked(administerCompetitionWave)
    .mockRejectedValue(new Error('Forbidden'));
  await expect(update(original)).rejects.toThrow('Forbidden');
  expect(competitionCommandRepository.saveCompetition).not.toHaveBeenCalled();
});

it('retains the stale-version guard', async () => {
  jest
    .mocked(lockNativeCompetition)
    .mockRejectedValue(new Error('Version conflict'));
  await expect(update(original)).rejects.toThrow('Version conflict');
  expect(competitionCommandRepository.saveCompetition).not.toHaveBeenCalled();
});
