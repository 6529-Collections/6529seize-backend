const mockLockCompetition = jest.fn();
const mockReadCompetition = jest.fn();
const mockFindSaved = jest.fn();
const mockGetHub = jest.fn();

jest.mock('@/competitions/competition-command.repository', () => ({
  competitionConflict: (message: string) => {
    throw new Error(message);
  },
  competitionCommandRepository: {
    lockCompetition: (...args: unknown[]) => mockLockCompetition(...args),
    findSavedCommand: (...args: unknown[]) => mockFindSaved(...args),
    command: jest.fn()
  }
}));
jest.mock('@/competitions/native-competition.reader', () => ({
  NativeCompetitionReader: jest.fn().mockImplementation(() => ({
    getCompetition: (...args: unknown[]) => mockReadCompetition(...args)
  }))
}));
jest.mock('@/competitions/competition.service', () => ({
  competitionService: {
    getHub: (...args: unknown[]) => mockGetHub(...args),
    getCompetition: jest.fn()
  }
}));
jest.mock('@/api/waves/wave.api.service', () => ({
  waveApiService: {
    prepareWaveCreation: jest.fn(),
    createWave: jest.fn(),
    validateNativeCompetitionConfiguration: jest.fn()
  }
}));
jest.mock('@/api/identities/identity.fetcher', () => ({ identityFetcher: {} }));

import { AuthenticationContext } from '@/auth-context';
import { RequestContext } from '@/request.context';
import { WavesFrozenException } from '@/waves-freeze/waves-freeze';
import { lockNativeCompetition } from './competition-command-access';
import { competitionLifecycleService } from './competition-lifecycle.service';
import { WaveHubCreationService } from './wave-hub-creation.service';

const NAMES = [
  'FEATURE_WAVES_FROZEN',
  'FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE',
  'WAVES_FREEZE_AT',
  'MAIN_STAGE_WAVE_ID'
];

describe('decision writes during the waves freeze', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of NAMES) original[name] = process.env[name];
  });
  beforeEach(() => {
    jest.clearAllMocks();
    for (const name of NAMES) delete process.env[name];
    mockLockCompetition.mockResolvedValue({
      id: 'comp',
      wave_id: 'wave',
      config_version: 3
    });
  });
  afterAll(() => {
    for (const name of NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  const ctx: RequestContext = {
    authenticationContext: new AuthenticationContext({
      authenticatedWallet: '0x1111111111111111111111111111111111111111',
      authenticatedProfileId: 'admin',
      roleProfileId: null,
      activeProxyActions: []
    })
  };

  function decision(capabilities: string[], waveId = 'wave') {
    return { id: 'comp', wave_id: waveId, capabilities };
  }

  it('locks and returns a decision when waves are not frozen', async () => {
    mockReadCompetition.mockResolvedValue(decision([]));
    await expect(
      lockNativeCompetition('wave', 'comp', 3, ctx)
    ).resolves.toEqual({
      record: expect.objectContaining({ id: 'comp' }),
      competition: decision([])
    });
  });

  it('refuses every entry, vote, edit and action while frozen', async () => {
    process.env.FEATURE_WAVES_FROZEN = 'true';
    mockReadCompetition.mockResolvedValue(decision(['MAIN_STAGE']));
    await expect(
      lockNativeCompetition('wave', 'comp', 3, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
  });

  it('keeps the Main Stage open when the freeze keeps it', async () => {
    process.env.FEATURE_WAVES_FROZEN = 'true';
    process.env.FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE = 'true';
    mockReadCompetition.mockResolvedValue(decision(['MAIN_STAGE']));
    await expect(
      lockNativeCompetition('wave', 'comp', 3, ctx)
    ).resolves.toEqual(expect.objectContaining({ record: expect.anything() }));
    mockReadCompetition.mockResolvedValue(decision(['CURATION']));
    await expect(
      lockNativeCompetition('wave', 'comp', 3, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
  });

  it('creates no decision while frozen, before any other check', async () => {
    process.env.FEATURE_WAVES_FROZEN = 'true';
    process.env.FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE = 'true';
    await expect(
      competitionLifecycleService.create(
        'wave',
        { idempotency_key: 'k', config: {} } as any,
        {}
      )
    ).rejects.toBeInstanceOf(WavesFrozenException);
  });

  it('creates no wave hub while frozen, but replays one made before', async () => {
    process.env.FEATURE_WAVES_FROZEN = 'true';
    const service = new WaveHubCreationService();
    const request = { idempotency_key: 'k', name: 'Hub' } as any;
    mockFindSaved.mockResolvedValue(null);
    await expect(service.create(request, ctx)).rejects.toBeInstanceOf(
      WavesFrozenException
    );
    mockFindSaved.mockResolvedValue({ id: 'hub' });
    mockGetHub.mockResolvedValue({ id: 'hub' });
    await expect(service.create(request, ctx)).resolves.toEqual({ id: 'hub' });
  });
});
