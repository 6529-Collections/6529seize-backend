import {
  HELP_BOT_CREDIT_GRANT_ENV,
  HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT,
  HELP_BOT_DEFAULT_CREDIT_GRANT,
  HELP_BOT_HANDLE,
  HELP_BOT_INSUFFICIENT_CREDITS_REACTION,
  HELP_BOT_INSUFFICIENT_CREDITS_REPLY,
  HELP_BOT_NO_RELIABLE_SOURCE_BASE_REPLY,
  HELP_BOT_PROFILE_SETUP_CREDIT_GRANT,
  HELP_BOT_QUESTION_CREDIT_COST,
  HELP_BOT_SIGNUP_CREDIT_GRANT,
  HELP_BOT_TECH_TEAM_HANDLES_ENV,
  buildHelpBotNoReliableSourceReply,
  getHelpBotCreditGrantAmount,
  getHelpBotTechTeamMentionHandles,
  isHelpBotCreditCategory,
  resolveHelpBotBaseUrl
} from './help-bot.config';

describe('help bot config', () => {
  const previousEnv = {
    creditGrant: process.env[HELP_BOT_CREDIT_GRANT_ENV],
    techTeamHandles: process.env[HELP_BOT_TECH_TEAM_HANDLES_ENV]
  };

  afterEach(() => {
    restoreEnv(HELP_BOT_CREDIT_GRANT_ENV, previousEnv.creditGrant);
    restoreEnv(HELP_BOT_TECH_TEAM_HANDLES_ENV, previousEnv.techTeamHandles);
  });

  it('uses the canonical help6529 trigger handle', () => {
    expect(HELP_BOT_HANDLE).toBe('help6529');
  });

  it('uses one configured amount for automatic credit grants', () => {
    expect(HELP_BOT_SIGNUP_CREDIT_GRANT).toBe(
      HELP_BOT_PROFILE_SETUP_CREDIT_GRANT
    );
    expect(HELP_BOT_PROFILE_SETUP_CREDIT_GRANT).toBe(
      HELP_BOT_DAILY_ACTIVITY_CREDIT_GRANT
    );
    expect(HELP_BOT_QUESTION_CREDIT_COST).toBe(1);
  });

  it('defaults the shared automatic credit grant amount to ten credits', () => {
    delete process.env[HELP_BOT_CREDIT_GRANT_ENV];

    expect(getHelpBotCreditGrantAmount()).toBe(HELP_BOT_DEFAULT_CREDIT_GRANT);
  });

  it('reads the shared automatic credit grant amount from env', () => {
    process.env[HELP_BOT_CREDIT_GRANT_ENV] = '12';

    expect(getHelpBotCreditGrantAmount()).toBe(12);
  });

  it('rejects invalid shared automatic credit grant amounts', () => {
    process.env[HELP_BOT_CREDIT_GRANT_ENV] = '1.5';

    expect(() => getHelpBotCreditGrantAmount()).toThrow(
      `${HELP_BOT_CREDIT_GRANT_ENV} must be a positive integer`
    );
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
      'You need at least 1 Help6529 Credit REP to ask a question. Help6529 Credits are REP in the `Help6529 Credits` category managed by help6529 for signup, profile setup, and daily activity.'
    );
  });

  it('matches the reserved credit category case-insensitively', () => {
    expect(isHelpBotCreditCategory('Help6529 Credits')).toBe(true);
    expect(isHelpBotCreditCategory(' help6529 credits ')).toBe(true);
    expect(isHelpBotCreditCategory('General')).toBe(false);
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
