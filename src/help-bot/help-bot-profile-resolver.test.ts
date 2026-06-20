import { RequestContext } from '@/request.context';
import { HelpBotProfileResolver } from './help-bot-profile-resolver';

describe('HelpBotProfileResolver', () => {
  const ctx = {} as RequestContext;

  function createProfilesDb(profileId: string | null = null) {
    return {
      getProfileByHandle: jest.fn().mockResolvedValue(
        profileId
          ? {
              external_id: profileId
            }
          : null
      )
    };
  }

  it('resolves the hardcoded help bot handle to a profile id', async () => {
    const getIdentityByHandle = jest.fn().mockResolvedValue({
      profile_id: 'profile-6529help'
    });
    const profilesDb = createProfilesDb();
    const resolver = new HelpBotProfileResolver(
      { getIdentityByHandle },
      profilesDb
    );

    await expect(resolver.resolveBotProfileId(ctx)).resolves.toBe(
      'profile-6529help'
    );
    expect(getIdentityByHandle).toHaveBeenCalledWith('6529help', ctx);
    expect(profilesDb.getProfileByHandle).not.toHaveBeenCalled();
  });

  it('falls back to the profile handle when the identity handle is not populated', async () => {
    const getIdentityByHandle = jest.fn().mockResolvedValue(null);
    const profilesDb = createProfilesDb('profile-6529help');
    const resolver = new HelpBotProfileResolver(
      { getIdentityByHandle },
      profilesDb
    );

    await expect(resolver.resolveBotProfileId(ctx)).resolves.toBe(
      'profile-6529help'
    );
    expect(profilesDb.getProfileByHandle).toHaveBeenCalledWith(
      '6529help',
      undefined
    );
  });

  it('caches successful handle resolution', async () => {
    let now = 1_000;
    const getIdentityByHandle = jest.fn().mockResolvedValue({
      profile_id: 'profile-6529help'
    });
    const profilesDb = createProfilesDb();
    const resolver = new HelpBotProfileResolver(
      { getIdentityByHandle },
      profilesDb,
      () => now
    );

    await expect(resolver.resolveBotProfileId(ctx)).resolves.toBe(
      'profile-6529help'
    );
    now += 1_000;
    await expect(resolver.resolveBotProfileId(ctx)).resolves.toBe(
      'profile-6529help'
    );

    expect(getIdentityByHandle).toHaveBeenCalledTimes(1);
  });

  it('returns null when the hardcoded handle does not exist', async () => {
    const getIdentityByHandle = jest.fn().mockResolvedValue(null);
    const resolver = new HelpBotProfileResolver(
      { getIdentityByHandle },
      createProfilesDb()
    );

    await expect(resolver.resolveBotProfileId(ctx)).resolves.toBeNull();
  });

  it('caches missing handle lookups briefly', async () => {
    let now = 1_000;
    const getIdentityByHandle = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ profile_id: 'profile-6529help' });
    const profilesDb = {
      getProfileByHandle: jest.fn().mockResolvedValue(null)
    };
    const resolver = new HelpBotProfileResolver(
      { getIdentityByHandle },
      profilesDb,
      () => now
    );

    await expect(resolver.resolveBotProfileId(ctx)).resolves.toBeNull();
    now += 1_000;
    await expect(resolver.resolveBotProfileId(ctx)).resolves.toBeNull();
    now += 30_000;
    await expect(resolver.resolveBotProfileId(ctx)).resolves.toBe(
      'profile-6529help'
    );

    expect(getIdentityByHandle).toHaveBeenCalledTimes(2);
  });
});
