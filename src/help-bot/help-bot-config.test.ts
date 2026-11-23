import {
  HELP_BOT_HANDLE,
  HELP_BOT_NO_RELIABLE_SOURCE_BASE_REPLY,
  HELP_BOT_TECH_TEAM_MENTION,
  buildHelpBotNoReliableSourceReply,
  resolveHelpBotBaseUrl
} from './help-bot.config';

describe('help bot config', () => {
  it('uses the canonical help6529 trigger handle', () => {
    expect(HELP_BOT_HANDLE).toBe('help6529');
  });

  it('uses the global developer mention for no-reliable-source escalation', () => {
    expect(HELP_BOT_TECH_TEAM_MENTION).toBe('@devs6529');
    expect(buildHelpBotNoReliableSourceReply()).toBe(
      `${HELP_BOT_NO_RELIABLE_SOURCE_BASE_REPLY} I'm flagging this so the tech team can double-check: @devs6529`
    );
  });

  it('uses the staging frontend help index base URL in development', () => {
    expect(resolveHelpBotBaseUrl('development')).toBe(
      'https://staging.6529.io'
    );
  });

  it('uses the staging frontend help index base URL in staging lambdas', () => {
    expect(resolveHelpBotBaseUrl(undefined, 'helpBotReplyLoop_staging')).toBe(
      'https://staging.6529.io'
    );
  });

  it('uses the production frontend help index base URL in production and local', () => {
    expect(resolveHelpBotBaseUrl('production')).toBe('https://6529.io');
    expect(resolveHelpBotBaseUrl('local')).toBe('https://6529.io');
  });
});
