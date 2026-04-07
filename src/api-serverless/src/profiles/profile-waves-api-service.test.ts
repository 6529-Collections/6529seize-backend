import { AuthenticationContext } from '@/auth-context';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { profileWavesDb } from '@/profiles/profile-waves.db';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { ProfileWavesApiService } from './profile-waves.api.service';

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
    jest
      .spyOn(identityFetcher, 'getIdentityAndConsolidationsByIdentityKey')
      .mockResolvedValue({ id: 'profile-1', profile_wave_id: 'wave-1' } as any);

    await expect(
      service.setProfileWave('profile-1', { wave_id: 'wave-1' } as any, {
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
      { profileId: 'profile-1', waveId: 'wave-1' },
      expect.objectContaining({ connection })
    );
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
});
