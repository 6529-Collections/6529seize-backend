import { IdentitiesHelpBotMentionResolver } from './help-bot-mention-resolver';

describe('IdentitiesHelpBotMentionResolver', () => {
  it('resolves configured handles to current profile handles in configured order', async () => {
    const getIdsByHandles = jest.fn().mockResolvedValue({
      'current-dev': 'profile-dev',
      Support: 'profile-support'
    });
    const resolver = new IdentitiesHelpBotMentionResolver({
      getIdsByHandles
    });
    const connection = {} as never;

    await expect(
      resolver.resolveMentionHandles(['current-dev', 'missing', 'support'], {
        connection
      } as never)
    ).resolves.toEqual(['current-dev', 'Support']);

    expect(getIdsByHandles).toHaveBeenCalledWith(
      ['current-dev', 'missing', 'support'],
      connection
    );
  });
});
