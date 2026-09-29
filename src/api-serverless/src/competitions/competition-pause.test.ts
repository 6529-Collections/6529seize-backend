import { competitionLifecycleService } from './competition-lifecycle.service';
import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { competitionCommandRepository } from '@/competitions/competition-command.repository';
import { nativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';
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
    replaceOutcomeDefinitions: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    recordLifecycle: jest.fn()
  }
}));

const action = (command: 'pause' | 'resume', reason?: string | null) =>
  competitionLifecycleService.action(
    'wave',
    'competition',
    command,
    {
      idempotency_key: 'request',
      config_version: 4,
      reason
    },
    {}
  );

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(administerCompetitionWave)
    .mockResolvedValue({ wave: { id: 'wave' } } as never);
  jest.mocked(lockNativeCompetition).mockResolvedValue({
    record: {
      id: 'competition',
      wave_id: 'wave',
      lifecycle: 'PUBLISHED',
      config_version: 4
    }
  } as never);
  jest
    .mocked(competitionCommandRepository.getConfiguration)
    .mockResolvedValue({} as ApiCompetitionDraftInput);
});

it.each([undefined, null, '', '   ', '\n\t'])(
  'rejects a blank pause reason (%p) without writing history',
  async (reason) => {
    await expect(action('pause', reason)).rejects.toThrow(
      'A reason is required'
    );
    expect(competitionCommandRepository.pause).not.toHaveBeenCalled();
    expect(competitionCommandRepository.saveCompetition).not.toHaveBeenCalled();
  }
);

it('persists the trimmed reason in pause and lifecycle history', async () => {
  await action('pause', '  Checking eligibility\nwith the team.  ');
  expect(competitionCommandRepository.pause).toHaveBeenCalledWith(
    'competition',
    expect.any(Number),
    null,
    'Checking eligibility\nwith the team.',
    expect.anything()
  );
  expect(competitionCommandRepository.recordLifecycle).toHaveBeenCalledWith(
    expect.anything(),
    'PUBLISHED',
    'admin',
    'Checking eligibility\nwith the team.',
    expect.anything()
  );
  expect(nativeCompetitionRuntimeRepository.enqueueEvent).toHaveBeenCalled();
});

it('allows resuming without another reason and keeps the original pause record', async () => {
  await action('resume');
  expect(competitionCommandRepository.resume).toHaveBeenCalledWith(
    'competition',
    expect.any(Number),
    expect.anything()
  );
  expect(competitionCommandRepository.pause).not.toHaveBeenCalled();
});

it('keeps administrator authorization required', async () => {
  jest
    .mocked(administerCompetitionWave)
    .mockRejectedValue(new Error('Forbidden'));
  await expect(action('pause', 'Review')).rejects.toThrow('Forbidden');
  expect(competitionCommandRepository.pause).not.toHaveBeenCalled();
});

it('keeps the version guard for a pause with a reason', async () => {
  jest
    .mocked(lockNativeCompetition)
    .mockRejectedValue(new Error('Version conflict'));
  await expect(action('pause', 'Review')).rejects.toThrow('Version conflict');
  expect(competitionCommandRepository.pause).not.toHaveBeenCalled();
});
