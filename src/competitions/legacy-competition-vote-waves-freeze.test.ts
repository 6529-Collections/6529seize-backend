const mockGetCompetition = jest.fn();
jest.mock('@/competitions/native-competition.reader', () => ({
  NativeCompetitionReader: jest.fn().mockImplementation(() => ({
    getCompetition: (...args: unknown[]) => mockGetCompetition(...args)
  }))
}));

import { WavesFrozenException } from '@/waves-freeze/waves-freeze';
import { voteForMigratedLegacyEntry } from './legacy-competition-vote.service';

const NAMES = [
  'FEATURE_WAVES_FROZEN',
  'FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE',
  'WAVES_FREEZE_AT',
  'MAIN_STAGE_WAVE_ID'
];

describe('legacy votes during the waves freeze', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of NAMES) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of NAMES) delete process.env[name];
    process.env.FEATURE_WAVES_FROZEN = 'true';
  });
  afterAll(() => {
    for (const name of NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  const record = { id: 'comp', wave_id: 'wave', legacy_wave_id: 'wave' } as any;
  const model = { wave_id: 'wave', drop_id: 'drop', voter_id: 'voter' } as any;
  const ctx = { connection: {} as any };

  function competition(capabilities: string[]) {
    // DISABLED stops the vote right after the freeze check.
    return {
      id: 'comp',
      wave_id: 'wave',
      capabilities,
      execution_mode: 'DISABLED'
    };
  }

  it('takes no vote while frozen', async () => {
    mockGetCompetition.mockResolvedValue(competition([]));
    await expect(
      voteForMigratedLegacyEntry(record, model, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
  });

  it('takes Main Stage votes when the freeze keeps it', async () => {
    process.env.FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE = 'true';
    mockGetCompetition.mockResolvedValue(competition(['MAIN_STAGE']));
    await expect(
      voteForMigratedLegacyEntry(record, model, ctx)
    ).rejects.toThrow('Voting is temporarily unavailable');
    mockGetCompetition.mockResolvedValue(competition([]));
    await expect(
      voteForMigratedLegacyEntry(record, model, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
  });
});
