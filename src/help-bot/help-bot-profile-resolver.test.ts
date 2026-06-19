import { RequestContext } from '@/request.context';
import { HelpBotProfileResolver } from './help-bot-profile-resolver';

describe('HelpBotProfileResolver', () => {
  const ctx = {} as RequestContext;

  it('resolves the hardcoded help bot handle to a profile id', async () => {
    const getIdentityByHandle = jest.fn().mockResolvedValue({
      profile_id: 'profile-6529help'
    });
    const resolver = new HelpBotProfileResolver({ getIdentityByHandle });

    await expect(resolver.resolveBotProfileId(ctx)).resolves.toBe(
      'profile-6529help'
    );
    expect(getIdentityByHandle).toHaveBeenCalledWith('6529help', ctx);
  });

  it('caches successful handle resolution', async () => {
    let now = 1_000;
    const getIdentityByHandle = jest.fn().mockResolvedValue({
      profile_id: 'profile-6529help'
    });
    const resolver = new HelpBotProfileResolver(
      { getIdentityByHandle },
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
    const resolver = new HelpBotProfileResolver({ getIdentityByHandle });

    await expect(resolver.resolveBotProfileId(ctx)).resolves.toBeNull();
  });

  it('caches missing handle lookups briefly', async () => {
    let now = 1_000;
    const getIdentityByHandle = jest.fn().mockResolvedValue(null);
    const resolver = new HelpBotProfileResolver(
      { getIdentityByHandle },
      () => now
    );

    await expect(resolver.resolveBotProfileId(ctx)).resolves.toBeNull();
    now += 1_000;
    await expect(resolver.resolveBotProfileId(ctx)).resolves.toBeNull();

    expect(getIdentityByHandle).toHaveBeenCalledTimes(1);
  });
});
