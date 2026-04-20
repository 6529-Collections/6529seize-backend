import { AuthenticationContext } from '@/auth-context';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { profileWavesDb } from '@/profiles/profile-waves.db';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { ProfileWavesApiService } from './profile-waves.api.service';
import { curationsDb } from '@/api/curations/curations.db';

describe('ProfileWavesApiService', () => {
  const service = new ProfileWavesApiService();

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sets an explicit profile wave for the owner', async () => {
    const connection = { id: 'tx' } as any;
    jest
      .spyOn(profileWavesDb, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (fn: any) => await fn(connection));
    jest
      .spyOn(identityFetcher, 'getProfileIdByIdentityKeyOrThrow')
      .mockResolvedValue('profile-1');
    jest.spyOn(wavesApiDb, 'findWaveById').mockResolvedValue({
      id: 'wave-1',
      created_by: 'profile-1',
      is_direct_message: false,
      visibility_group_id: null
    } as any);
    const setSpy = jest
      .spyOn(profileWavesDb, 'setProfileWave')
      .mockResolvedValue(undefined);
    const getIdentitySpy = jest
      .spyOn(identityFetcher, 'getIdentityAndConsolidationsByIdentityKey')
      .mockResolvedValue({ id: 'profile-1', profile_wave_id: 'wave-1' } as any);

    await expect(
      service.setProfileWave('alice', { wave_id: 'wave-1' } as any, {
        authenticationContext: AuthenticationContext.fromProfileId('profile-1'),
        timer: undefined
      })
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'profile-1',
        profile_wave_id: 'wave-1'
      })
    );

    expect(setSpy).toHaveBeenCalledWith(
      { profileId: 'profile-1', waveId: 'wave-1', profileCurationId: null },
      expect.objectContaining({ connection })
    );
    expect(getIdentitySpy).toHaveBeenCalledWith(
      { identityKey: 'alice' },
      expect.objectContaining({ connection })
    );
  });

  it('sets a valid profile curation for the selected profile wave', async () => {
    const connection = { id: 'tx' } as any;
    jest
      .spyOn(profileWavesDb, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (fn: any) => await fn(connection));
    jest
      .spyOn(identityFetcher, 'getProfileIdByIdentityKeyOrThrow')
      .mockResolvedValue('profile-1');
    jest.spyOn(wavesApiDb, 'findWaveById').mockResolvedValue({
      id: 'wave-1',
      created_by: 'profile-1',
      is_direct_message: false,
      visibility_group_id: null
    } as any);
    const findCurationSpy = jest
      .spyOn(curationsDb, 'findWaveCurationById')
      .mockResolvedValue({
        id: 'curation-1',
        wave_id: 'wave-1'
      } as any);
    const setSpy = jest
      .spyOn(profileWavesDb, 'setProfileWave')
      .mockResolvedValue(undefined);
    jest
      .spyOn(identityFetcher, 'getIdentityAndConsolidationsByIdentityKey')
      .mockResolvedValue({ id: 'profile-1', profile_wave_id: 'wave-1' } as any);

    await expect(
      service.setProfileWave(
        'alice',
        { wave_id: 'wave-1', profile_curation_id: 'curation-1' } as any,
        {
          authenticationContext:
            AuthenticationContext.fromProfileId('profile-1'),
          timer: undefined
        }
      )
    ).resolves.toEqual(expect.objectContaining({ id: 'profile-1' }));

    expect(findCurationSpy).toHaveBeenCalledWith(
      { id: 'curation-1', wave_id: 'wave-1' },
      connection
    );
    expect(setSpy).toHaveBeenCalledWith(
      {
        profileId: 'profile-1',
        waveId: 'wave-1',
        profileCurationId: 'curation-1'
      },
      expect.objectContaining({ connection })
    );
  });

  it('rejects profile curation ids outside the selected profile wave', async () => {
    const connection = { id: 'tx' } as any;
    jest
      .spyOn(profileWavesDb, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (fn: any) => await fn(connection));
    jest
      .spyOn(identityFetcher, 'getProfileIdByIdentityKeyOrThrow')
      .mockResolvedValue('profile-1');
    jest.spyOn(wavesApiDb, 'findWaveById').mockResolvedValue({
      id: 'wave-1',
      created_by: 'profile-1',
      is_direct_message: false,
      visibility_group_id: null
    } as any);
    jest.spyOn(curationsDb, 'findWaveCurationById').mockResolvedValue(null);
    const setSpy = jest
      .spyOn(profileWavesDb, 'setProfileWave')
      .mockResolvedValue(undefined);

    await expect(
      service.setProfileWave(
        'alice',
        { wave_id: 'wave-1', profile_curation_id: 'curation-2' } as any,
        {
          authenticationContext:
            AuthenticationContext.fromProfileId('profile-1'),
          timer: undefined
        }
      )
    ).rejects.toThrow(`Curation curation-2 not found`);

    expect(setSpy).not.toHaveBeenCalled();
  });

  it('rejects proxies', async () => {
    await expect(
      service.clearProfileWave('profile-1', {
        authenticationContext: new AuthenticationContext({
          authenticatedWallet: '0x123',
          authenticatedProfileId: 'proxy-1',
          roleProfileId: 'profile-1',
          activeProxyActions: []
        }),
        timer: undefined
      })
    ).rejects.toThrow(`Proxies cannot change profile waves`);
  });

  it('rejects non-public waves', async () => {
    const connection = { id: 'tx' } as any;
    jest
      .spyOn(profileWavesDb, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (fn: any) => await fn(connection));
    jest
      .spyOn(identityFetcher, 'getProfileIdByIdentityKeyOrThrow')
      .mockResolvedValue('profile-1');
    jest.spyOn(wavesApiDb, 'findWaveById').mockResolvedValue({
      id: 'wave-1',
      created_by: 'profile-1',
      is_direct_message: false,
      visibility_group_id: 'group-1'
    } as any);

    await expect(
      service.setProfileWave('profile-1', { wave_id: 'wave-1' } as any, {
        authenticationContext: AuthenticationContext.fromProfileId('profile-1'),
        timer: undefined
      })
    ).rejects.toThrow(`Profile wave must be public`);
  });

  it('clears a profile wave and reads identity back using the original identity key', async () => {
    const connection = { id: 'tx' } as any;
    jest
      .spyOn(profileWavesDb, 'executeNativeQueriesInTransaction')
      .mockImplementation(async (fn: any) => await fn(connection));
    jest
      .spyOn(identityFetcher, 'getProfileIdByIdentityKeyOrThrow')
      .mockResolvedValue('profile-1');
    const deleteSpy = jest
      .spyOn(profileWavesDb, 'deleteByProfileId')
      .mockResolvedValue(undefined);
    const getIdentitySpy = jest
      .spyOn(identityFetcher, 'getIdentityAndConsolidationsByIdentityKey')
      .mockResolvedValue({ id: 'profile-1', profile_wave_id: null } as any);

    await expect(
      service.clearProfileWave('alice', {
        authenticationContext: AuthenticationContext.fromProfileId('profile-1'),
        timer: undefined
      })
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'profile-1',
        profile_wave_id: null
      })
    );

    expect(deleteSpy).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ connection })
    );
    expect(getIdentitySpy).toHaveBeenCalledWith(
      { identityKey: 'alice' },
      expect.objectContaining({ connection })
    );
  });

  it('returns the effective profile wave and profile curation', async () => {
    jest
      .spyOn(identityFetcher, 'getProfileIdByIdentityKeyOrThrow')
      .mockResolvedValue('profile-1');
    const findEffectiveSpy = jest
      .spyOn(profileWavesDb, 'findEffectiveProfileWaveByProfileId')
      .mockResolvedValue({
        profile_wave_id: 'wave-1',
        profile_curation_id: 'curation-1'
      });

    await expect(
      service.getProfileWave('alice', { timer: undefined })
    ).resolves.toEqual({
      profile_wave_id: 'wave-1',
      profile_curation_id: 'curation-1'
    });

    expect(findEffectiveSpy).toHaveBeenCalledWith(
      'profile-1',
      expect.anything()
    );
  });

  it('returns nulls when a profile has no selected profile wave', async () => {
    jest
      .spyOn(identityFetcher, 'getProfileIdByIdentityKeyOrThrow')
      .mockResolvedValue('profile-1');
    jest
      .spyOn(profileWavesDb, 'findEffectiveProfileWaveByProfileId')
      .mockResolvedValue(null);

    await expect(
      service.getProfileWave('alice', { timer: undefined })
    ).resolves.toEqual({
      profile_wave_id: null,
      profile_curation_id: null
    });
  });
});
