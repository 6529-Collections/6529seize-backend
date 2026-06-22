import {
  HELP_BOT_INSUFFICIENT_CREDITS_REACTION,
  HELP_BOT_INSUFFICIENT_CREDITS_REPLY,
  HELP_BOT_NO_RELIABLE_SOURCE_BASE_REPLY,
  HELP_BOT_TECH_TEAM_HANDLES_ENV,
  buildHelpBotNoReliableSourceReply,
  getHelpBotTechTeamMentionHandles,
  resolveHelpBotBaseUrl
} from './help-bot.config';

describe('help bot config', () => {
  const previousTechTeamHandles = process.env[HELP_BOT_TECH_TEAM_HANDLES_ENV];

  afterEach(() => {
    if (previousTechTeamHandles === undefined) {
      delete process.env[HELP_BOT_TECH_TEAM_HANDLES_ENV];
      return;
    }
    process.env[HELP_BOT_TECH_TEAM_HANDLES_ENV] = previousTechTeamHandles;
  });

  it('omits tech team mentions when the env var is missing', () => {
    delete process.env[HELP_BOT_TECH_TEAM_HANDLES_ENV];

    expect(getHelpBotTechTeamMentionHandles()).toEqual([]);
    expect(buildHelpBotNoReliableSourceReply()).toBe(
      HELP_BOT_NO_RELIABLE_SOURCE_BASE_REPLY
    );
  });

  it('uses low-battery insufficient-credit reaction and REP-category copy', () => {
    expect(HELP_BOT_INSUFFICIENT_CREDITS_REACTION).toBe(':low_battery:');
    expect(HELP_BOT_INSUFFICIENT_CREDITS_REPLY).toBe(
      'You need at least 1 Help6529 Credit REP to ask a question. Help6529 Credits are REP in the `Help6529 Credits` category granted by help6529 for signup, profile setup, and daily activity; ratings from other profiles in that category do not count for bot questions.'
    );
  });

  it('normalizes, filters, and dedupes tech team handles', () => {
    process.env[HELP_BOT_TECH_TEAM_HANDLES_ENV] =
      ' @Alice ,bob,alice,bad handle,@carol ';

    expect(getHelpBotTechTeamMentionHandles()).toEqual([
      'Alice',
      'bob',
      'carol'
    ]);
    expect(buildHelpBotNoReliableSourceReply()).toBe(
      `${HELP_BOT_NO_RELIABLE_SOURCE_BASE_REPLY} I'm flagging this so the tech team can double-check: @[Alice] @[bob] @[carol]`
    );
  });

  it('accepts semicolon-separated tech team handles for compatibility', () => {
    process.env[HELP_BOT_TECH_TEAM_HANDLES_ENV] = 'dev-team;@support';

    expect(getHelpBotTechTeamMentionHandles()).toEqual(['dev-team', 'support']);
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
