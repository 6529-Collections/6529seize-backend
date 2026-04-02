import { IdentityWavesService } from '@/identities/identity-waves.service';
import { WaveType } from '@/entities/IWave';

describe('IdentityWavesService', () => {
  const profileId = 'profile-1';
  const waveId = 'wave-1';

  function createService() {
    const identitiesDb = {
      updateIdentityWave: jest.fn().mockResolvedValue(undefined),
      clearIdentityWaveByWaveId: jest.fn().mockResolvedValue(undefined),
      existsIdentityWithWaveId: jest.fn().mockResolvedValue(false)
    };
    const wavesApiDb = {
      lockById: jest.fn().mockResolvedValue({
        id: waveId,
        created_by: profileId,
        type: WaveType.CHAT,
        visibility_group_id: null
      })
    };

    return {
      service: new IdentityWavesService(identitiesDb as any, wavesApiDb as any),
      identitiesDb,
      wavesApiDb,
      ctx: {
        connection: {},
        timer: undefined
      } as any
    };
  }

  it('locks the wave before auto-assigning an eligible identity wave', async () => {
    const { service, identitiesDb, wavesApiDb, ctx } = createService();

    await expect(
      service.setIdentityWaveIfEligible({ profileId, waveId }, ctx)
    ).resolves.toBe(true);

    expect(wavesApiDb.lockById).toHaveBeenCalledWith(waveId, ctx);
    expect(identitiesDb.updateIdentityWave).toHaveBeenCalledWith(
      {
        profileId,
        waveId
      },
      ctx
    );
  });

  it('returns false when the locked wave is not eligible', async () => {
    const { service, identitiesDb, wavesApiDb, ctx } = createService();
    wavesApiDb.lockById.mockResolvedValue({
      id: waveId,
      created_by: profileId,
      type: WaveType.CHAT,
      visibility_group_id: 'group-1'
    });

    await expect(
      service.setIdentityWaveIfEligible({ profileId, waveId }, ctx)
    ).resolves.toBe(false);

    expect(identitiesDb.updateIdentityWave).not.toHaveBeenCalled();
  });

  it('locks the wave before allowing it to become private', async () => {
    const { service, identitiesDb, wavesApiDb, ctx } = createService();
    identitiesDb.existsIdentityWithWaveId.mockResolvedValue(true);

    await expect(
      service.assertWaveCanBeMadePrivate(
        {
          waveId,
          visibilityGroupId: 'group-1'
        },
        ctx
      )
    ).rejects.toThrow(`A wave used as an identity wave cannot be made private`);

    expect(wavesApiDb.lockById).toHaveBeenCalledWith(waveId, ctx);
    expect(identitiesDb.existsIdentityWithWaveId).toHaveBeenCalledWith(
      { waveId },
      ctx
    );
  });

  it('fails fast when the locked wave does not exist', async () => {
    const { service, identitiesDb, wavesApiDb, ctx } = createService();
    wavesApiDb.lockById.mockResolvedValue(null);

    await expect(
      service.assertWaveCanBeMadePrivate(
        {
          waveId,
          visibilityGroupId: 'group-1'
        },
        ctx
      )
    ).rejects.toThrow(`Wave ${waveId} not found`);

    expect(identitiesDb.existsIdentityWithWaveId).not.toHaveBeenCalled();
  });
});
