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
import { Time, Timer } from '@/time';
import { WavesFrozenException } from '@/waves-freeze/waves-freeze';
import { WaveApiService } from './wave.api.service';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';
import { wavesScopeService } from '@/waves-scope/waves-scope.service';

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

const chatWaveRequest = {
  wave: { type: 'CHAT', admin_group: { group_id: null } },
  visibility: { scope: { group_id: null } },
  chat: { scope: { group_id: null } },
  participation: { scope: { group_id: null } },
  voting: { scope: { group_id: null } }
} as any;

// Every wave moves unless a test says otherwise.
beforeEach(() => {
  stubWavesScope();
});

describe('wave writes during the waves freeze', () => {
  const original: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const name of NAMES) original[name] = process.env[name];
  });
  beforeEach(() => {
    for (const name of NAMES) delete process.env[name];
    process.env.FEATURE_WAVES_FROZEN = 'true';
  });
  afterEach(() => {
    jest.restoreAllMocks();
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

  it('makes no new wave while frozen, members-only or private ones too', async () => {
    for (const request of [
      { ...chatWaveRequest, visibility: { scope: { group_id: 'members' } } },
      { ...chatWaveRequest, chat: { scope: { group_id: 'private-group' } } }
    ]) {
      stubWavesScope({ staying: ['wave'] });
      const forWave = service(wave);
      const relations = jest
        .spyOn(forWave as any, 'validateWaveRelations')
        .mockRejectedValue(PAST_FREEZE);
      await expect(
        forWave.createWave(request, false, ctx)
      ).rejects.toBeInstanceOf(WavesFrozenException);
      expect(relations).not.toHaveBeenCalled();
    }
  });

  it('checks again in the transaction, right before the wave is written', async () => {
    delete process.env.FEATURE_WAVES_FROZEN;
    const freeze = Date.UTC(2026, 10, 25);
    process.env.WAVES_FREEZE_AT = new Date(freeze).toISOString();
    const now = jest.spyOn(Time, 'currentMillis').mockReturnValue(freeze - 1);
    const forWave = service(wave);
    const db = (forWave as any).wavesApiDb;
    db.insertWave = jest.fn();
    // The last step before the wave row is written: the freeze starts then.
    (forWave as any).waveMappers = {
      createWaveToNewWaveEntity: jest.fn(async () => {
        now.mockReturnValue(freeze + 1);
        return { id: 'new' };
      })
    };
    jest
      .spyOn(forWave as any, 'validateWaveRelations')
      .mockResolvedValue(undefined);
    jest.spyOn(forWave as any, 'validateOutcomes').mockReturnValue(undefined);
    jest
      .spyOn(forWave as any, 'validateSubwaveCreationParent')
      .mockResolvedValue(undefined);
    const prepared = {
      id: 'new',
      descriptionDropModel: {},
      descriptionPrePublication: {}
    } as any;
    await expect(
      forWave.createWave(chatWaveRequest, false, ctx, undefined, prepared)
    ).rejects.toBeInstanceOf(WavesFrozenException);
    expect(db.executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
    expect(db.insertWave).not.toHaveBeenCalled();
  });

  it("checks again after the description drop's locks", async () => {
    delete process.env.FEATURE_WAVES_FROZEN;
    const freeze = Date.UTC(2026, 10, 25);
    process.env.WAVES_FREEZE_AT = new Date(freeze).toISOString();
    const now = jest.spyOn(Time, 'currentMillis').mockReturnValue(freeze - 1);
    const forWave = service(wave);
    const db = (forWave as any).wavesApiDb;
    db.insertWave = jest.fn();
    db.updateDescriptionDropId = jest.fn();
    (forWave as any).waveMappers = {
      createWaveToNewWaveEntity: jest.fn().mockResolvedValue({ id: 'new' })
    };
    // The description drop waits on the creator's profile lock, then runs
    // the check it was given; the freeze starts during that wait.
    (forWave as any).createOrUpdateDrop = {
      execute: jest.fn(async (_model, _isDescription, options) => {
        now.mockReturnValue(freeze + 1);
        await options.recheckWavesFreeze();
        throw PAST_FREEZE;
      })
    };
    jest
      .spyOn(forWave as any, 'validateWaveRelations')
      .mockResolvedValue(undefined);
    jest.spyOn(forWave as any, 'validateOutcomes').mockReturnValue(undefined);
    jest
      .spyOn(forWave as any, 'validateSubwaveCreationParent')
      .mockResolvedValue(undefined);
    const prepared = {
      id: 'new',
      descriptionDropModel: {},
      descriptionPrePublication: {}
    } as any;
    await expect(
      forWave.createWave(chatWaveRequest, false, ctx, undefined, prepared)
    ).rejects.toBeInstanceOf(WavesFrozenException);
    expect(db.insertWave).toHaveBeenCalledTimes(1);
    expect(db.updateDescriptionDropId).not.toHaveBeenCalled();
  });

  it('pins no drop in a wave while frozen, but a direct message still can', async () => {
    const pin = (forWave: WaveApiService, waveId: string) =>
      forWave.setPinnedDrop(waveId, { drop_id: 'drop' } as any, ctx);
    for (const target of [wave, dm]) {
      const forWave = service(target);
      const db = (forWave as any).wavesApiDb;
      db.updateDescriptionDropId = jest.fn().mockRejectedValue(PAST_FREEZE);
      (forWave as any).dropsDb = {
        findDropById: jest
          .fn()
          .mockResolvedValue({ id: 'drop', wave_id: target.id })
      };
      if (target === wave) {
        await expect(pin(forWave, target.id)).rejects.toBeInstanceOf(
          WavesFrozenException
        );
        expect(db.updateDescriptionDropId).not.toHaveBeenCalled();
      } else {
        await expect(pin(forWave, target.id)).rejects.toBe(PAST_FREEZE);
      }
    }
  });

  it('pins as before when waves are not frozen', async () => {
    delete process.env.FEATURE_WAVES_FROZEN;
    const forWave = service(wave);
    const db = (forWave as any).wavesApiDb;
    db.updateDescriptionDropId = jest.fn().mockRejectedValue(PAST_FREEZE);
    (forWave as any).dropsDb = {
      findDropById: jest.fn().mockResolvedValue({ id: 'drop', wave_id: 'wave' })
    };
    await expect(
      forWave.setPinnedDrop('wave', { drop_id: 'drop' } as any, ctx)
    ).rejects.toBe(PAST_FREEZE);
  });

  it('edits, pins and deletes a wave that stays on 6529.io while frozen', async () => {
    stubWavesScope({ staying: ['wave'] });
    await expect(service(wave).updateWave('wave', {} as any, ctx)).rejects.toBe(
      PAST_FREEZE
    );
    await expect(service(wave).deleteWave('wave', ctx)).rejects.toBe(
      PAST_FREEZE
    );
    const forHub = service(wave);
    jest
      .spyOn(forHub as any, 'validateWaveHubUpdate')
      .mockRejectedValue(PAST_FREEZE);
    await expect(
      forHub.updateWaveHub('wave', { name: 'Renamed' } as any, ctx)
    ).rejects.toBe(PAST_FREEZE);
  });

  it('refuses a hub edit that would make a staying wave move', async () => {
    let staysNow = true;
    jest
      .spyOn(wavesScopeService, 'waveStays')
      .mockImplementation(async () => staysNow);
    const forWave = service(wave);
    const db = (forWave as any).wavesApiDb;
    db.findWaveHubConfigurationForUpdate = jest.fn().mockResolvedValue({});
    db.deleteWave = jest.fn();
    db.insertWave = jest.fn(async () => {
      // Say the edit dropped the wave's visibility group.
      staysNow = false;
    });
    jest
      .spyOn(forWave as any, 'validateWaveHubUpdate')
      .mockResolvedValue(undefined);
    (forWave as any).metricsRecorder = {
      recordActiveIdentity: jest.fn().mockRejectedValue(PAST_FREEZE)
    };
    await expect(
      forWave.updateWaveHub('wave', { name: 'Renamed' } as any, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
    expect(db.insertWave).toHaveBeenCalledTimes(1);
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
    const patch = { name: 'Renamed' } as any;
    await expect(
      service(wave).updateWaveHub('wave', patch, ctx)
    ).rejects.toBeInstanceOf(WavesFrozenException);
    const forDm = service(dm);
    jest
      .spyOn(forDm as any, 'validateWaveHubUpdate')
      .mockRejectedValue(PAST_FREEZE);
    await expect(forDm.updateWaveHub('dm', patch, ctx)).rejects.toBe(
      PAST_FREEZE
    );
  });

  it('deletes no wave, but a direct message still can be deleted', async () => {
    await expect(service(wave).deleteWave('wave', ctx)).rejects.toBeInstanceOf(
      WavesFrozenException
    );
    await expect(service(dm).deleteWave('dm', ctx)).rejects.toBe(PAST_FREEZE);
  });

  it('answers an empty hub patch (the legacy pause routes send one)', async () => {
    const forWave = service(wave);
    jest
      .spyOn(forWave as any, 'mapEditedWaveHub')
      .mockResolvedValue({ id: 'wave' });
    await expect(forWave.updateWaveHub('wave', {}, ctx)).resolves.toEqual({
      id: 'wave'
    });
  });

  it('changes nothing when waves are not frozen', async () => {
    delete process.env.FEATURE_WAVES_FROZEN;
    await expect(service(wave).updateWave('wave', {} as any, ctx)).rejects.toBe(
      PAST_FREEZE
    );
    await expect(service(wave).deleteWave('wave', ctx)).rejects.toBe(
      PAST_FREEZE
    );
    const forWave = service(wave);
    jest
      .spyOn(forWave as any, 'validateWaveHubUpdate')
      .mockRejectedValue(PAST_FREEZE);
    await expect(
      forWave.updateWaveHub('wave', { name: 'Renamed' } as any, ctx)
    ).rejects.toBe(PAST_FREEZE);
  });
});
