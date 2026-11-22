jest.mock('@/competitions/legacy-competition-mutation', () => ({
  withLegacyPrimaryMutation: (
    _waveId: string,
    _ctx: unknown,
    action: (record: null) => unknown
  ) => action(null),
  reconcileAcceptedLegacySettings: jest.fn()
}));
jest.mock('@/api/waves/wave-access.helpers', () => ({
  ...jest.requireActual('@/api/waves/wave-access.helpers'),
  assertWaveAndParentVisibleOrThrow: jest.fn(
    async ({ wave }: { wave: unknown }) => wave
  )
}));

import { AuthenticationContext } from '@/auth-context';
import { Timer } from '@/time';
import { WavesFrozenException } from '@/waves-freeze/waves-freeze';
import { WaveApiService } from './wave.api.service';

const NAMES = [
  'FEATURE_WAVES_FROZEN',
  'FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE',
  'WAVES_FREEZE_AT',
  'MAIN_STAGE_WAVE_ID'
];

/** Thrown by a stub one step past the freeze check. */
const PAST_FREEZE = new Error('past the waves freeze check');

function service(wave: { id: string; is_direct_message: boolean }) {
  const wavesApiDb = {
    executeNativeQueriesInTransaction: jest.fn(async (callback) =>
      callback({})
    ),
    findWaveById: jest.fn().mockResolvedValue({ ...wave, created_by: 'me' }),
    findWaveByIdForUpdate: jest.fn().mockResolvedValue(wave),
    findWaveHubById: jest.fn().mockResolvedValue({ ...wave, created_by: 'me' }),
    findSubwaveIdsByParentWaveId: jest.fn().mockRejectedValue(PAST_FREEZE)
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
  };
  const result = new WaveApiService(
    wavesApiDb as any,
    userGroupsService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  jest
    .spyOn(result as any, 'validateWaveUpdateAccessAndConstraints')
    .mockRejectedValue(PAST_FREEZE);
  jest
    .spyOn(result as any, 'assertUserAllowedToModifyPauses')
    .mockRejectedValue(PAST_FREEZE);
  return result;
}

const ctx = {
  timer: new Timer('waves-freeze-test'),
  authenticationContext: new AuthenticationContext({
    authenticatedWallet: '0x1111111111111111111111111111111111111111',
    authenticatedProfileId: 'me',
    roleProfileId: null,
    activeProxyActions: []
  })
};

const chatWaveRequest = { wave: { type: 'CHAT' } } as any;

describe('wave writes during the waves freeze', () => {
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

  const wave = { id: 'wave', is_direct_message: false };
  const dm = { id: 'dm', is_direct_message: true };

  it('creates no wave, but direct messages still open', async () => {
    await expect(
      service(wave).createWave(chatWaveRequest, false, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
    const forDm = service(dm);
    jest
      .spyOn(forDm as any, 'validateWaveRelations')
      .mockRejectedValue(PAST_FREEZE);
    await expect(forDm.createWave(chatWaveRequest, true, ctx)).rejects.toBe(
      PAST_FREEZE
    );
  });

  it('edits no wave, but a direct message still can be', async () => {
    await expect(
      service(wave).updateWave('wave', {} as any, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
    await expect(service(dm).updateWave('dm', {} as any, ctx)).rejects.toBe(
      PAST_FREEZE
    );
  });

  it('edits no wave hub, but a direct message still can be', async () => {
    await expect(
      service(wave).updateWaveHub('wave', {} as any, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
    await expect(
      service(dm).updateWaveHub('dm', {} as any, ctx)
    ).rejects.not.toBeInstanceOf(WavesFrozenException);
  });

  it('deletes no wave, but a direct message still can be deleted', async () => {
    await expect(service(wave).deleteWave('wave', ctx)).rejects.toBeInstanceOf(
      WavesFrozenException
    );
    await expect(service(dm).deleteWave('dm', ctx)).rejects.toBe(PAST_FREEZE);
  });

  it('changes no decision pause, except the Main Stage when kept', async () => {
    process.env.MAIN_STAGE_WAVE_ID = 'main';
    const pause = { start_time: 1, end_time: 2 } as any;
    await expect(
      service(wave).createOrUpdateWavePause('main', pause, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
    await expect(
      service(wave).deleteWavePause('main', 1, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
    process.env.FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE = 'true';
    await expect(
      service(wave).createOrUpdateWavePause('main', pause, ctx)
    ).rejects.toBe(PAST_FREEZE);
    await expect(service(wave).deleteWavePause('main', 1, ctx)).rejects.toBe(
      PAST_FREEZE
    );
    await expect(
      service(wave).deleteWavePause('other', 1, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
  });

  it('changes nothing when waves are not frozen', async () => {
    delete process.env.FEATURE_WAVES_FROZEN;
    await expect(service(wave).updateWave('wave', {} as any, ctx)).rejects.toBe(
      PAST_FREEZE
    );
    await expect(service(wave).deleteWave('wave', ctx)).rejects.toBe(
      PAST_FREEZE
    );
    await expect(service(wave).deleteWavePause('wave', 1, ctx)).rejects.toBe(
      PAST_FREEZE
    );
  });
});
